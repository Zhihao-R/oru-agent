/**
 * Steering 回合循环：起回合后，每轮跑完在回合边界按 runTurn 的 TurnOutcome 分流——
 * 正常跑完（ok）drain 队列有 leftover 就续跑；故障（error）或中断（aborted）不自动续跑，
 * 把未消费队列显式交还用户发落（G13/G14）。
 *
 * 这是「回合末读」+「故障后不续跑」的实现核心——与后端无关：anthropic/openai/claude-code 任一
 * 后端，一轮 turn 自然结束时若有「将生效」积压未被中途读入，concludeTurn 把它们落盘 + 续跑读入。
 * 中途读入（工具边界 pullSteering）是各后端各自的增强，不在本循环里——本循环只兜回合边界。
 *
 * running 标志的生命周期：enqueueOrStart 返回 started / beginDirectTurn 返回 true 时由队列置 true；
 * 本循环跑到 concludeTurn 返回 idle、或 error/aborted 交还后置回 false。
 *
 * 交还的 token 归属（§6 承重）：归属凭据在占闸那一刻铸造、由入口线程化传入（deps.token），
 * error/aborted 分支用它调 handBackIfRunning——只作用于自己拥有的回合。Esc 抢先交还后若新回合
 * 已起，旧循环带旧 token 交还会因 token 失配返回 null（不误清新回合的 running）。
 */
import { type TurnOutcome } from '../ws/runChatAndPersist';
import {
  steeringQueue as defaultQueue,
  type SteeringMsg,
  type SteeringQueueApi,
} from './steeringQueue';

export type SteeringTurnLoopDeps = {
  /** per-conv 队列 key（steeringKey(agentId, conversationId)）。 */
  key: string;
  /**
   * 回合归属凭据（§6）：占闸那一刻（enqueueOrStart started / beginDirectTurn）铸造并由入口
   * 线程化传入——不在循环里事后补读 runToken()，入口占闸与起循环之间隔着 await，期间 Esc+新回合
   * 会翻新 token，补读读到的是别人的凭据（会误清新回合的闸）。
   */
  token: number;
  /** 首轮的用户文本（起回合那条）；续跑轮一律 undefined（从 history 读）。 */
  firstText: string | undefined;
  /** 注入用队列；缺省走单例，测试可注入。 */
  queue?: SteeringQueueApi;
  /**
   * 跑一轮 turn 到结束（runChatAndPersist 语义——永不 reject），返回该轮 TurnOutcome。
   * userText=undefined 表示续跑：从 history 末尾读（restart / 审批后续跑同源）。
   * restartBatch：本轮由 concludeTurn 合并进来的积压批（G70 装配标注取材）；首轮为 undefined。
   */
  runTurn: (userText: string | undefined, restartBatch?: SteeringMsg[]) => Promise<TurnOutcome>;
  /**
   * 把一批 steering 落盘为正式 user 历史消息 **并广播 chat.steering.consumed**（单源）。
   * 抛错 = 落盘失败：concludeTurn 会整批留队列（原则 4），本循环据此停转、留待下次接手。
   */
  persistConsumed: (msgs: SteeringMsg[]) => Promise<void>;
  /**
   * 故障 / 远程刹车后未消费队列的交还（G14）：广播 chat.queue.handback 让前端按类型呈现。
   * Esc 桌面按停走 chat.abort 自己交还，此回调不涉；空批次不调。
   */
  onHandback: (items: SteeringMsg[]) => void;
  /**
   * 队首轮到模式指令（/loop，T2 切批）：item 已由 concludeTurn 落盘出队，闸保持 running 同
   * token——本回调把它转投 loop 编排并**负责最终释闸**（编排 finally handBackIfRunning）。
   * 回调返回后本循环直接收工（闸的所有权已移交）。
   */
  startLoop: (item: SteeringMsg) => Promise<void>;
};

export async function runSteeringTurnLoop(deps: SteeringTurnLoopDeps): Promise<TurnOutcome> {
  const q = deps.queue ?? defaultQueue;
  const token = deps.token; // 回合归属凭据：占闸那一刻由入口铸造并传入（§6）
  // 起点归属校验：入口占闸到起循环之间隔着 await（appendMessage / getAgent 等），期间用户可能已
  // Esc（甚至新回合已起）——闸不再属于本回合就一轮都不跑，Esc 不被静默击败。isRunning/runToken
  // 是同步读，主线程内与首轮 runTurn 之间无让出点。
  if (!q.isRunning(deps.key) || q.runToken(deps.key) !== token) return 'aborted';
  let userText = deps.firstText;
  let restartBatch: SteeringMsg[] | undefined;
  // 防御性回合上限：steering 续跑应在秒级被队列背压收敛；给一个远高于任何真实场景的兜底，
  // 防 persistConsumed 反复成功但队列因 bug 不空导致的活锁（正常路径靠 idle 退出）。
  for (let guard = 0; guard < 1000; guard += 1) {
    const outcome = await deps.runTurn(userText, restartBatch);

    if (outcome !== 'ok') {
      // error / aborted：不 concludeTurn、不续跑（G13 故障后不自动续跑）。按 token 归属交还（§6）：
      // - error：running 必是本回合的 → 取批 + 置 idle（队列空也停转）。
      // - aborted：Esc 已抢先交还（token 失配 / 已 idle）→ null，循环直接停；远程刹车未交还 → 取批交还。
      // 循环见到首个非 ok 即停，故其后不会再有轮次——无需跨轮 outcome 累积，直接上交该终态。
      const batch = await q.handBackIfRunning(deps.key, token);
      if (batch && batch.length > 0) deps.onHandback(batch);
      return outcome;
    }

    let r;
    try {
      r = await q.concludeTurn(deps.key, token, deps.persistConsumed);
    } catch {
      // 落盘故障（persistConsumed 抛错）也不冻结对话：走 G13/G14 同一条交还路——把未消费队列交还
      // 用户发落、释放闸，而非留 running=true 让对话卡到重启。concludeTurn 抛错时 takeAndPersist
      // 在清队列前就抛了、队列原样保留，handBackIfRunning 据 token 取走整批 + 置 idle + 清盘记
      // （盘记清除是 best-effort，磁盘坏了也不阻塞交还——交还只广播事件、不依赖盘）。
      const batch = await q.handBackIfRunning(deps.key, token);
      if (batch && batch.length > 0) deps.onHandback(batch);
      return 'error';
    }
    if ('idle' in r) return 'ok';
    if ('startLoop' in r) {
      // 闸的所有权移交给 loop 编排（同 token）；编排结束时自行 handBackIfRunning 释闸。
      await deps.startLoop(r.startLoop);
      return 'ok';
    }
    userText = undefined; // 续跑从 history 读 restart 那批
    restartBatch = r.restart; // 传给下一轮 runTurn 装配合并标注（G70）
  }
  return 'ok';
}
