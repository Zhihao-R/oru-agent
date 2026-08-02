/**
 * 服务端 steering 队列 —— 「对话忙时中途转向」的唯一裁决者。
 *
 * 每个对话一把锁（串行下列全部操作），杜绝竞态：
 * - enqueueOrStart：chat.send 入口，**锁内原子**裁决「起回合 vs 入队」——并发回合的根除点。
 * - pullSteering：边界 drain，取走当时全部、**落盘先于投递**、persist 成功才清队列（失败整批留队列重试）。
 * - withdraw：仍在队列则删，否则 alreadyConsumed。
 * - concludeTurn：回合收尾，有 leftover 则落盘 + 续跑新回合（回合末读），否则置 idle。
 * - drainUnconsumedOnAbort：Esc 取走未消费、清队列、置 idle（退回输入框）。
 *
 * 「消费」的定义点是 persist 那一刻（落盘在投递之前）——见技术方案原则 4。
 * 本模块只管协调（锁 + running 标志 + 有序队列），落盘/投递的具体形态交给 persist 回调，
 * 保持 provider-agnostic。
 *
 * 崩溃兜底（2026-07-03 审计 critical#1）：队列本体在内存，消费前崩溃会静默蒸发——
 * 故每次队列变更在同一把锁内镜像到 backup 盘记（入队写、消费/Esc/撤回清）。盘记只是
 * 崩溃备份，不改「消费=persist 那一刻」的提交点语义；重启后残留盘记经 steeringBackup
 * 的扫描-交还路径预填草稿交还用户，绝不自动执行。
 */
import { newMessageId } from '@shared/ids';
import type {
  ChatAttachment,
  ChatMessageKind,
  ScheduledTriggerPayload,
  TriggerOrigin,
  TurnTriggerType,
} from '@shared/types';
import { fileSteeringBackup } from './steeringBackup';
import { isLiveTurnRestartable } from './liveTurnMark';

/**
 * kind/scheduledTrigger 由队列原样透传到 persist（定时任务忙时入队也保留触发卡渲染所需 payload）。
 * S08：trigger 是队列语义轴一等字段（必填）——pullSteering 只取 'user'、机器项等回合结束（G12）；
 * origin/attachments 随项透传（渠道来源 S10 填、附件本期只保证队列/盘记/交还全程带引用）。
 */
export type SteeringMsg = {
  clientMsgId: string;
  serverId: string;
  text: string;
  trigger: TurnTriggerType;
  origin?: TriggerOrigin;
  attachments?: ChatAttachment[];
  kind?: ChatMessageKind;
  scheduledTrigger?: ScheduledTriggerPayload;
  /**
   * 模式指令标记（2026-07-28 loop 去特殊化 T2）：用户发的、但**不作插话**的指令（/loop 开一个循环）。
   * trigger 轴不动（它就是用户的话——Esc / 崩溃盘记按用户项交还草稿），只改消费面：
   * pullSteering / pendingUserCount 跳过它，concludeTurn 在它处切批、单独转投 loop 编排。
   */
  modeCommand?: 'loop';
};

/** 入队消息（serverId 由队列锁内分配，故不在入参里）。 */
export type EnqueueMsg = {
  clientMsgId: string;
  text: string;
  trigger: TurnTriggerType;
  origin?: TriggerOrigin;
  attachments?: ChatAttachment[];
  kind?: ChatMessageKind;
  scheduledTrigger?: ScheduledTriggerPayload;
  /** 模式指令标记（见 SteeringMsg.modeCommand）。 */
  modeCommand?: 'loop';
};

/** started 携带回合归属凭据 token（§6）：占闸那一刻铸造并交给占闸方，入口须线程化传给回合循环。 */
export type EnqueueResult =
  | { action: 'started'; token: number }
  | { action: 'enqueued'; serverId: string }
  /**
   * 连发撤起（S1 三态之 busy-restartIfClean）：在飞回合窗口内且无产出——消息不入队，
   * token 翻新交入口杀旧回合、带更全历史重起（被撤回合的一切队列操作随旧 token 失效，
   * 不触发 handback——承重口径见 liveTurnMark 头注释）。
   */
  | { action: 'restart'; token: number };

/**
 * 在飞回合可撤性探针（S1）：「窗口内且无产出」的判定数据由装配层在事件流上单点打标
 * （liveTurnMark），队列经此探针只读；测试注入 fake 只验裁决三态。
 */
export type LiveTurnProbe = { isRestartable(key: string): boolean };

const defaultLiveTurnProbe: LiveTurnProbe = { isRestartable: isLiveTurnRestartable };

export type ConcludeResult =
  | { idle: true }
  | { restart: SteeringMsg[] }
  /**
   * 队首是模式指令（/loop）：该项已落盘出队，闸保持 running 同 token——调用方单独转投
   * loop 编排（编排收 runToken、结束时 handBackIfRunning 归还）。指令之后的项留队。
   */
  | { startLoop: SteeringMsg };

/** 把消息批落盘为正式历史的回调；抛错表示落盘失败（整批留队列重试）。 */
export type PersistFn = (msgs: SteeringMsg[]) => Promise<void>;

/**
 * 崩溃盘记后端：全量镜像该 conv 的未消费队列（空数组=清除盘记）。
 * 恒与内存变更同锁调用——盘记 ≡ 队列 的不变量由锁保证，实现方无需再挡并发。
 */
export interface SteeringBackup {
  save(key: string, pending: SteeringMsg[]): Promise<void>;
}

export interface SteeringQueueApi {
  enqueueOrStart(key: string, msg: EnqueueMsg): Promise<EnqueueResult>;
  /**
   * 闸外回合占闸（G11）：不落新消息的续跑 / 播报轮 / [重试] 起回合前调它——锁内 running 则
   * 返回 null（别双跑），否则置 true 并返回归属凭据 token（§6）。与 enqueueOrStart 是仅有的
   * 两个起回合口；占到闸的入口必须把 token 线程化传给回合循环 / 释放调用。
   */
  beginDirectTurn(key: string): Promise<number | null>;
  /**
   * 故障 / 远程刹车交还（G13/G14）：锁内校验回合归属（token 与当前 runToken 相符），相符则
   * 取走全部＋置 idle＋返回批次；不 running 或 token 失配（已被交还 / 已是别的回合）返回 null。
   * token 由 runToken(key) 在回合起点读取——防「旧循环误清新回合的 running」（§6 回归）。
   */
  handBackIfRunning(key: string, token: number): Promise<SteeringMsg[] | null>;
  /**
   * 只取 trigger==='user' 的项（保序）、机器项留队到 concludeTurn（G12）；落盘先于清队。
   * token 归属校验（§6）：非当前回合（Esc 后已被新回合接替的僵尸轮）返回空、不动队列。
   */
  pullSteering(key: string, token: number, persist: PersistFn): Promise<SteeringMsg[]>;
  /** 待读入的 user 项条数——hasPendingSteering 据它决定 claude-code 是否 interrupt 截断（G12）。 */
  pendingUserCount(key: string): number;
  /**
   * 队列里是否已有该 trigger 类型的待处理项（S09/G69 去重）：后台完成播报入队前查它——
   * 已有一条排队的 task-completed 就不再入第二条（那条起回合时 buildUnannouncedTaskHint 会
   * 列全部未播报任务，多入只会多出空播报轮）。running 中的回合不算（已出队），故只看 queue。
   */
  hasQueuedTrigger(key: string, trigger: TurnTriggerType): boolean;
  withdraw(key: string, clientMsgId: string): Promise<'removed' | 'alreadyConsumed'>;
  /**
   * 回合收尾。token 归属校验（§6）：与 handBackIfRunning 同族——「正常收尾」同样是释放闸/消费
   * 队列的口，僵尸轮（流式已完、尾部 await 期间被 Esc+新回合接替）不校验会清别人的闸、偷别人的批。
   * 失配返回 idle 且零副作用（僵尸轮就此停转）。
   */
  concludeTurn(key: string, token: number, persist: PersistFn): Promise<ConcludeResult>;
  drainUnconsumedOnAbort(key: string): Promise<SteeringMsg[]>;
  isRunning(key: string): boolean;
  pendingCount(key: string): number;
  /** 当前回合归属凭据（每次 running false→true 自增）；回合起点读取，交给 handBackIfRunning 校验。 */
  runToken(key: string): number;
  /**
   * 唤醒对账用：枚举当前所有 running=true 的对话（key=steeringKey `agentId:conversationId`）。
   * states Map 是 createSteeringQueue 闭包私有，wake 侧要遍历在途对话必须经此 accessor 读。
   */
  listRunningKeys(): string[];
}

type ConvState = {
  running: boolean;
  /** 回合归属凭据：每次 running false→true 自增。post-turn 清理只作用于自己拥有的回合（§6）。 */
  runToken: number;
  queue: SteeringMsg[];
  /** per-conv 串行锁：所有改 running/queue 的操作排这条链上原子执行 */
  chain: Promise<unknown>;
};

export function steeringKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

export function createSteeringQueue(
  genId: () => string = newMessageId,
  backup?: SteeringBackup,
  liveTurns: LiveTurnProbe = defaultLiveTurnProbe,
): SteeringQueueApi {
  const states = new Map<string, ConvState>();

  function stateOf(key: string): ConvState {
    let s = states.get(key);
    if (!s) {
      s = { running: false, runToken: 0, queue: [], chain: Promise.resolve() };
      states.set(key, s);
    }
    return s;
  }

  /** 起回合：置 running 并翻新归属凭据（§6 token），凭据即刻交给占闸方——两个起回合口共用。 */
  function markRunning(s: ConvState): number {
    s.running = true;
    s.runToken += 1;
    return s.runToken;
  }

  /**
   * 盘记同步（best-effort）：persist 已成功后清/收窄盘记，失败只告警不上抛——把它变成失败会
   * 导致整批重复投递；清不掉的后果只是重启后重复交还（宁重复不丢，方向安全）。
   */
  async function mirrorBackup(key: string, pending: SteeringMsg[]): Promise<void> {
    if (!backup) return;
    try {
      await backup.save(key, pending);
    } catch (e) {
      console.warn('[steering] 盘记同步失败（重启后或重复交还，宁重复不丢）:', e);
    }
  }

  /** 把 fn 串到该 conv 的锁链上原子执行（前一操作出错不打断后续）。 */
  function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const s = stateOf(key);
    const next = s.chain.then(fn, fn);
    s.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * 锁内取走全部 + 落盘先于清空：persist 成功才清队列，失败保留整批并抛出。
   * 盘记随批清（不逐条）：persist 是整批一次调用，崩在「persist 成功、盘记清除前」的窗口
   * = 整批重启后重复交还——宁可交还重复、不可静默丢。
   */
  async function takeAndPersist(key: string, s: ConvState, persist: PersistFn): Promise<SteeringMsg[]> {
    if (s.queue.length === 0) return [];
    const batch = s.queue.slice();
    await persist(batch); // 落盘先于投递；抛错则不清队列（盘记也原样保留）
    s.queue.length = 0;
    await mirrorBackup(key, []); // 消费=persist 成功那一刻，同锁同步清盘记
    return batch;
  }

  /** 有轮次间隙插入资格的项（G12）：用户的话，且不是模式指令（/loop 是「开一个循环」，不作插话）。 */
  const isInterjection = (m: SteeringMsg): boolean => m.trigger === 'user' && !m.modeCommand;

  /**
   * 分型取出（G12）：只取可插话项（保序）、落盘先于清，机器项与模式指令留队到 concludeTurn。
   * 盘记收窄到剩余，不整清——与 withdraw 的「盘记 ≡ 剩余队列」同款。
   */
  async function takeUserAndPersist(key: string, s: ConvState, persist: PersistFn): Promise<SteeringMsg[]> {
    const userItems = s.queue.filter(isInterjection);
    if (userItems.length === 0) return [];
    await persist(userItems); // 落盘先于投递；抛错则不动队列/盘记
    s.queue = s.queue.filter((m) => !isInterjection(m));
    await mirrorBackup(key, s.queue); // 盘记收窄到剩余项
    return userItems;
  }

  return {
    enqueueOrStart(key, msg) {
      return withLock(key, async () => {
        const s = stateOf(key);
        if (s.running) {
          // 连发撤起（S1 三态之 busy-restartIfClean）：在飞回合窗口内且无产出 → 不入队，
          // 翻新 token 交入口杀旧回合重跑。仅用户消息可触发——机器触发（scheduled /
          // task-completed）与模式指令（/loop）照走排队，不被撤起语义沾染。
          if (msg.trigger === 'user' && !msg.modeCommand && liveTurns.isRestartable(key)) {
            return { action: 'restart', token: markRunning(s) } as EnqueueResult;
          }
          const serverId = genId();
          s.queue.push({
            clientMsgId: msg.clientMsgId,
            serverId,
            text: msg.text,
            trigger: msg.trigger,
            origin: msg.origin,
            attachments: msg.attachments,
            kind: msg.kind,
            scheduledTrigger: msg.scheduledTrigger,
            modeCommand: msg.modeCommand,
          });
          if (backup) {
            try {
              await backup.save(key, s.queue); // 入队即留崩溃盘记——ACK 从此意味着「崩溃也不丢」
            } catch (e) {
              s.queue.pop(); // 写不了盘记就回滚入队、如实报错，不给出「已受理」的假承诺
              throw e;
            }
          }
          return { action: 'enqueued', serverId } as EnqueueResult;
        }
        return { action: 'started', token: markRunning(s) } as EnqueueResult;
      });
    },

    beginDirectTurn(key) {
      return withLock(key, () => {
        const s = stateOf(key);
        if (s.running) return null;
        return markRunning(s);
      });
    },

    handBackIfRunning(key, token) {
      return withLock(key, async () => {
        const s = stateOf(key);
        // 不 running（已被交还）或 token 失配（当前是别的回合）→ 不碰，返回 null。
        if (!s.running || s.runToken !== token) return null;
        const batch = s.queue.slice();
        s.queue.length = 0;
        s.running = false;
        if (batch.length > 0) await mirrorBackup(key, []); // 交还即清盘记
        return batch;
      });
    },

    pullSteering(key, token, persist) {
      return withLock(key, () => {
        const s = stateOf(key);
        if (!s.running || s.runToken !== token) return []; // 僵尸轮不消费别人的队列
        return takeUserAndPersist(key, s, persist);
      });
    },

    pendingUserCount(key) {
      // 模式指令不计入：它不被 pullSteering 消费，计入会让 claude-code 在工具边界为它反复
      // interrupt 却永远拉不走（死循环）。
      const s = states.get(key);
      return s ? s.queue.filter(isInterjection).length : 0;
    },

    hasQueuedTrigger(key, trigger) {
      return states.get(key)?.queue.some((m) => m.trigger === trigger) ?? false;
    },

    runToken(key) {
      return stateOf(key).runToken;
    },

    withdraw(key, clientMsgId) {
      return withLock(key, async () => {
        const s = stateOf(key);
        const i = s.queue.findIndex((m) => m.clientMsgId === clientMsgId);
        if (i < 0) return 'alreadyConsumed' as const;
        s.queue.splice(i, 1);
        // 盘记收窄到剩余项。失败只告警：内存已撤成，最坏是重启后被撤的那条重现为草稿（宁重复不丢）
        if (backup) {
          try {
            await backup.save(key, s.queue);
          } catch (e) {
            console.warn('[steering] 撤回后盘记更新失败（重启后或重现为草稿）:', e);
          }
        }
        return 'removed' as const;
      });
    },

    concludeTurn(key, token, persist) {
      return withLock(key, async () => {
        const s = stateOf(key);
        // 归属失配（§6）：闸已属别的回合（或已 idle），零副作用返回 idle——不清别人的闸、不偷批。
        if (!s.running || s.runToken !== token) return { idle: true } as ConcludeResult;
        if (s.queue.length === 0) {
          s.running = false;
          return { idle: true } as ConcludeResult;
        }
        // 模式指令（/loop）处切批（T2）：指令前的普通项照常续跑一回合，指令及其后留队；
        // 轮到指令打头时单独转投 loop 编排（闸保持 running 同 token，编排结束时归还）。
        const idx = s.queue.findIndex((m) => m.modeCommand);
        if (idx === 0) {
          const item = s.queue[0];
          await persist([item]); // 落盘先于投递；抛错则整批留队（原则 4）
          s.queue.shift();
          await mirrorBackup(key, s.queue);
          return { startLoop: item } as ConcludeResult;
        }
        if (idx > 0) {
          const front = s.queue.slice(0, idx);
          await persist(front);
          s.queue = s.queue.slice(idx);
          await mirrorBackup(key, s.queue);
          return { restart: front } as ConcludeResult;
        }
        // 无模式指令：整批落盘后续跑新回合（running 维持 true）
        const restart = await takeAndPersist(key, s, persist);
        return { restart } as ConcludeResult;
      });
    },

    drainUnconsumedOnAbort(key) {
      return withLock(key, async () => {
        const s = stateOf(key);
        const drained = s.queue.slice();
        s.queue.length = 0;
        s.running = false;
        // Esc 已把这些项退回输入框（交还完成）——盘记同步清，崩溃重启后不再交还第二遍。
        // 队列本就为空（如附件校验 bail 的 releaseStartedTurn）时无盘记可清，不碰磁盘。
        if (drained.length > 0) await mirrorBackup(key, []);
        return drained;
      });
    },

    isRunning(key) {
      return states.get(key)?.running ?? false;
    },

    pendingCount(key) {
      return states.get(key)?.queue.length ?? 0;
    },

    listRunningKeys() {
      const out: string[] = [];
      for (const [key, s] of states) if (s.running) out.push(key);
      return out;
    },
  };
}

/** 生产单例：接文件盘记——chat.send / 定时任务 / 平台入站全走这一个实例，兜底自动覆盖所有入队方。 */
export const steeringQueue: SteeringQueueApi = createSteeringQueue(newMessageId, fileSteeringBackup);
