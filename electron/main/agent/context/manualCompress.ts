/**
 * 手动压缩主进程入口（斜杠命令补全 plan §2）——「回合外手动触发压缩」的唯一内核。
 * 两个调用点：ws 路由 conv.compress（桌面 /compress）与 gateway dep（平台 /compress）——
 * 一个内核，两个入口。
 *
 * 串行化：用 steering 闸做整个临界区（beginDirectTurn 占闸 → 读 history → 摘要 LLM（最长
 * ~90s）→ 落卡 → 清号 → 释闸），防 TOCTOU——一次性 isRunning 检查通过后全程无保护的话，
 * 窗口内新回合起跑会把旧 sdkSessionId 写回（压缩白做）、双 /compress 并发产双卡。占闸期间
 * 入站消息走 enqueueOrStart 正常排队，不丢；释闸时按回合末同款语义把排队批续跑。
 *
 * 与回合内整理（organizeContext）的关系：本入口只做「有损摘要」这一段（force 直压），
 * 不复用 organizeContext——它的 null 合并了「user 轮数不足 / 无可压段」两种情形，而手动
 * 压缩的回执必须区分「对话还太短」与「没有新内容可压」。折叠（Tier 1）由下个回合入口的
 * 整理自动推进，不在此抢做。
 */
import type { Broadcast } from '../../ws/server';
import {
  appendMessage,
  getConversation,
  readHistoryForLLM,
  updateFoldedBeforeMessageId,
  updateSdkSessionId,
} from '../../conversations/store';
import { getAgent } from '../store/agents';
import { getSettings } from '../../projects/store';
import { steeringQueue, steeringKey, type SteeringQueueApi } from '../steeringQueue';
import { runSteeringTurnLoop } from '../steeringTurnLoop';
import { buildMainTurnRunner, handOffLoopFromSteering } from '../../ws/handlers/mainTurnAssembly';
import { compressIfNeeded, KEEP_RECENT_ROUNDS, PostCompressOverflowError } from './compress';
import { organizeThreshold } from './organize';
import { computeFoldWatermark } from './applyTier1Folding';
import { invalidatePriorReads } from '../conversationFileState';

export type ManualCompressResult =
  | { status: 'compressed'; fallback: boolean }
  | { status: 'busy' }
  /** tooShort=对话还太短（user 轮数不足保留段）；nothingNew=上次摘要后没有新内容可压 */
  | { status: 'empty'; emptyReason: 'tooShort' | 'nothingNew' }
  | { status: 'failed' };

/** 模型真窗未知（OAuth 默认档 / 老数据缺 contextWindow）时的兜底——与 runner.ts 同一默认。 */
const FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * 手动强制压缩一条对话的上下文。四态返回，回执文案由调用方按状态映射（i18n 在调用层）。
 * 'failed' 含 PostCompressOverflowError（单条大消息超装载目标）与意外异常——gateway 串行链
 * 会吞异常（then(task, task)），不在这里映射成状态回执用户就石沉大海。
 */
export async function forceCompressConversation(
  agentId: string,
  convId: string,
  broadcast: Broadcast,
  queue: SteeringQueueApi = steeringQueue,
): Promise<ManualCompressResult> {
  const key = steeringKey(agentId, convId);
  // 占闸：占不到 = 有回合在跑 → busy。占闸同时封死「读 history → 摘要 → 落卡 → 清号」全程。
  const token = await queue.beginDirectTurn(key);
  if (token === null) return { status: 'busy' };
  try {
    return await compressHeldConversation(agentId, convId, broadcast);
  } catch (e) {
    if (e instanceof PostCompressOverflowError) return { status: 'failed' };
    console.error('[manualCompress] 手动压缩意外失败:', e);
    return { status: 'failed' };
  } finally {
    await releaseGateAndContinue(agentId, convId, key, token, broadcast, queue);
  }
}

/** 闸内临界区：读 history → 阈值 → force 压缩 → 落卡 / 清号 / 失效先读。调用方已占闸。 */
async function compressHeldConversation(
  agentId: string,
  convId: string,
  broadcast: Broadcast,
): Promise<ManualCompressResult> {
  const history = await readHistoryForLLM(agentId, convId);
  // user 轮数不足保留段 → compressIfNeeded 内部也会返回 null（compress.ts 边界），
  // 但回执要区分「太短」与「没有新内容」，故提前判（常量与 compress.ts 同源）。
  const userCount = history.reduce((n, m) => (m.role === 'user' ? n + 1 : n), 0);
  if (userCount < KEEP_RECENT_ROUNDS) return { status: 'empty', emptyReason: 'tooShort' };

  // 阈值：当前 twinMain 模型的真窗过半（organizeThreshold），与回合内整理同一水位。
  // 两路兜底写明：assignment 为 null（OAuth 默认档）或 contextWindow 缺省（老数据）→ 200k。
  const settings = await getSettings();
  const assignment = settings.modelAssignments.twinMain;
  const model = assignment ? settings.models.find((m) => m.id === assignment) : undefined;
  const threshold = organizeThreshold(model?.contextWindow ?? FALLBACK_CONTEXT_WINDOW);

  const compressed = await compressIfNeeded({
    conversationId: convId,
    history,
    // systemContext 传空串——读码核实过的取舍（review 复核）：sysTokens 是 baseTokens 的一部分，
    // selectN 与终校验都对齐它（compress.ts），空串 = 少算整个 system 段（人设+记忆快照+运行时，
    // 量级数千~两万 token）。不注入真实值的理由：真实 systemContext 是回合装配产物（buildSnapshot +
    // buildRuntimeContext + stable + provision，runner.ts 开篇一大段），为 token 估算在回合外重装一遍
    // 是更大的漂移源。代价有界且自愈：装载目标 = 真窗/2，余量罩得住；真超了由下回合入口整理的
    // 无损折叠兜住（不调 LLM）——压缩卡的「腾出量」可能略小于名义值，但不会撞窗。
    systemContext: '',
    threshold,
    force: true,
    agentId,
  });
  if (!compressed) return { status: 'empty', emptyReason: 'nothingNew' };

  // 真压成（含 fallback 硬丢）——三个承重收尾，与回合内整理同语义：
  // 1. 被摘要吞掉的 read_file 结果必须失效（否则模型「看不到内容却被告知参考上次读取」）。
  invalidatePriorReads(convId);
  // 2. 作废 sdkSessionId（G112 同语义）——不清号则 claudeCode 后端下回合续传旧 CLI 上下文，
  //    压缩白做。写盘失败不阻塞（本地视图已整理，下回合 runner 自会再判）。
  await updateSdkSessionId(agentId, convId, null).catch((e) => {
    console.warn('[manualCompress] 弃号写盘失败（下回合 runner 会再判）:', e);
  });
  // 3. 折叠水印重钉到新视图边界（organize.ts 摘要段同款；无可折内容则清空）。
  await updateFoldedBeforeMessageId(agentId, convId, computeFoldWatermark(compressed.trimmedHistory)).catch(
    (e) => {
      console.warn('[manualCompress] 水印重钉失败（下回合整理会再推进）:', e);
    },
  );
  // 落卡 + 广播（与 ws/handlers/turnArgs.ts onContextCompressed 同形）。
  // 落盘失败不假装成功——压缩卡是用户可见的「已压缩」承诺，写不进盘就如实 failed。
  await appendMessage(agentId, convId, compressed.notificationMessage);
  broadcast({ type: 'chat.contextCompressed', conversationId: convId, message: compressed.notificationMessage });
  return { status: 'compressed', fallback: compressed.fallback };
}

/**
 * 释闸：concludeTurn 空队置 idle；占闸窗口期排进来的项按回合末同款语义续跑——
 * 批落盘（persistConsumed）后转投 runSteeringTurnLoop（firstText=undefined 从 history 读，
 * 与回合末续跑同源）。续跑 fire-and-forget：压缩回执不等续跑回合。
 */
async function releaseGateAndContinue(
  agentId: string,
  convId: string,
  key: string,
  token: number,
  broadcast: Broadcast,
  queue: SteeringQueueApi,
): Promise<void> {
  let runner;
  try {
    const agent = await getAgent(agentId);
    const conversation = await getConversation(agentId, convId);
    runner = buildMainTurnRunner({ agentId, agent, conversation, broadcast, runToken: token });
  } catch (e) {
    // 取数失败必须释放刚占的闸（否则对话永久卡「运行中」）——按 token 归属交还，不误清别人的回合。
    console.warn('[manualCompress] 释闸装配取数失败，按归属交还释闸:', e);
    await queue.handBackIfRunning(key, token);
    return;
  }
  let r;
  try {
    r = await queue.concludeTurn(key, token, runner.persistConsumed);
  } catch (e) {
    // 落盘故障也不冻结对话：steeringTurnLoop 同款交还路——整批留队由 handBack 取走交还用户发落。
    console.warn('[manualCompress] 释闸落盘失败，交还队列:', e);
    const batch = await queue.handBackIfRunning(key, token);
    if (batch && batch.length > 0) runner.onHandback(batch);
    return;
  }
  if ('idle' in r) return;
  if ('startLoop' in r) {
    // 队首是 /loop 模式指令：闸保持 running 同 token，转投 loop 编排（编排收尾自行释闸）。
    // fire-and-forget（review M1）：handOffLoopFromSteering await 的是整个 loop 编排（可能数小时），
    // await 它会把本函数的 finally 链——上游 conv.compress 回执与 gateway 串行链——全程扣押。
    // 编排侧收尾三件套（catch 记日志 / 按 token 释闸 / 交还剩余队列）自足，不等它。
    void handOffLoopFromSteering({ agentId, conversationId: convId, runToken: token, broadcast, item: r.startLoop });
    return;
  }
  void runSteeringTurnLoop({
    key,
    token,
    firstText: undefined,
    persistConsumed: runner.persistConsumed,
    onHandback: runner.onHandback,
    startLoop: (item) =>
      handOffLoopFromSteering({ agentId, conversationId: convId, runToken: token, broadcast, item }),
    runTurn: (userText, restartBatch) => runner.runOneTurn({ userText, restartBatch }),
  });
}
