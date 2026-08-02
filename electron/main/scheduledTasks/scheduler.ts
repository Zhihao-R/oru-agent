/**
 * 定时任务调度内核（S18 后台执行路径）
 *
 * 骨架 = autoArchiver 的 start/stop/inflight 护栏 + 持久化绝对时间戳 nextRunAt 的轮询
 * （不采用 setTimeout-per-task：休眠唤醒/漏跑判定/任务多时更稳，且与 autoArchiver 同构）。
 *
 * S18 三段执行链：调度（tick）→ 后台执行体（executor.spawnScheduledRun）→ 结果落盘。本模块只管
 * 调度段：时区锚核对（G100）、到点宽限窗判定（G99）、到点一次落盘「推进游标 ＋ 记投递账」（G41）
 * 后 fire-and-forget 交给 spawn（不 await——tick 不再被执行拖住，一条长执行不拖迟其他任务的到点）。
 * 结算（计次/销账）单点在执行体（G43），本模块不再 recordRun。
 *
 * 编排逻辑全部参数化在注入的 SchedulerDeps 上（时钟 + store 原语 + spawn），便于单测注入内存 store
 * 与 spawn spy；生产 deps 在 index.ts 装配（store + executor.spawnScheduledRun）。
 *
 * 承重一致性（CLAUDE.md「await 后重检」）：tick 逐个处理 due 之间隔着 await，期间用户可能在 UI 改了
 * 任务。fireDueTask 内部必按 id 重读最新任务再判，绝不沿用 tick 开头的快照。
 */
import type { PendingFire, ScheduledTask } from '@shared/types';
import { advanceNextRun, collapseMissedToLatest, recomputeForTimeZone } from './schedule';

/** 桌面够细、远低于 1 分钟的最小触发间隔，不浪费。 */
export const TICK_MS = 30_000;

/** 到点宽限窗（S18·G99，PM 拍板 5 分钟＝10 个 tick）：落后在窗内当到点正常触发；超窗按错过交用户。 */
export const GRACE_MS = 5 * 60_000;

export interface SchedulerDeps {
  now(): number;
  list(): Promise<ScheduledTask[]>;
  get(id: string): Promise<ScheduledTask | null>;
  patch(id: string, patch: Partial<ScheduledTask>): Promise<ScheduledTask | null>;
  /** 到点一次原子写：推进游标 ＋ 追加一笔投递账（G41）。advance 在锁内基于最新 cur 算（防覆盖用户中途暂停）。 */
  recordFire(
    id: string,
    fire: PendingFire,
    computeAdvance: (cur: ScheduledTask) => { nextRunAt: number | null; enabled: boolean },
  ): Promise<ScheduledTask | null>;
  /** 开机对账收编残留账（G41 崩溃窗口）：pendingFires 非空 → 按重验标错过或静默销账。 */
  reconcileFires(id: string): Promise<ScheduledTask | null>;
  /**
   * 后台执行体入口（executor.spawnScheduledRun）。fire-and-forget——同步做 inflight 串行合并与
   * 占位，返回是否撞上进行中的执行体（manual 撞上时供 RPC 提示「已在执行中」）；实际跑完在后台，不 await。
   */
  spawn(taskId: string, opts: { manual?: boolean; late?: boolean }): { alreadyRunning: boolean };
  /** 任何改动 store 后回调（广播全端最新状态）；可选，背景/单测不挂。 */
  onStateChanged?(): Promise<void> | void;
}

// ─── 模块级单例（副作用：定时器）+ inflight 护栏 ───────────────────────
let timer: ReturnType<typeof setInterval> | null = null;
let tickInflight = false;
let activeDeps: SchedulerDeps | null = null;
/** 开机对账完成前，setInterval 的 tick 一律让位——把「先对账再首扫」从「reconcile 必 30s 内完成」
 *  的隐性时序假设变成显式保证（慢盘/高负载下 reconcile 超一个 tick 周期也不会被抢跑）。 */
let reconcileDone = false;
/** 最近一次 tick 完成时刻——「调度停摆」看门狗据此判心跳是否变陈（S14 · G106）。 */
let lastTickAt = 0;

/** 调度器健康快照：是否在跑 + 最近心跳时刻。看门狗（notifications/feeds）轮询它。 */
export function getSchedulerHealth(): { started: boolean; lastTickAt: number } {
  return { started: timer !== null, lastTickAt };
}

export function startScheduledTasks(deps: SchedulerDeps): void {
  if (timer) return;
  activeDeps = deps;
  // reconcile 未完成前周期 tick 让位（把「先对账再首扫」变成显式保证，不靠「reconcile 必 30s 内完成」）。
  timer = setInterval(() => {
    if (reconcileDone) void tickOnce(deps);
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // 先对账漏跑、再首扫：reconcile 把错过的标 missedAt 并推进 nextRunAt 到 future，串行在首 tick 之前，
  // 避免「漏跑还没标记就被 tick 当 due 触发」。reconcileDone 置位后 setInterval 的 tick 才放行（见 tickOnce）。
  reconcileDone = false;
  void reconcileOnBoot(deps)
    .then(() => {
      reconcileDone = true;
      return tickOnce(deps);
    })
    .catch((e) => {
      reconcileDone = true; // 对账失败也放行轮询，别把调度整个卡死
      console.warn('[scheduledTasks] 启动对账失败', e);
    });
}

export function stopScheduledTasks(): void {
  if (timer) clearInterval(timer);
  timer = null;
  activeDeps = null;
  tickInflight = false;
  reconcileDone = false;
}

/** 单轮护栏：上一轮未结束直接 return（对齐 autoArchiver scanInflight）。 */
export async function tickOnce(deps: SchedulerDeps): Promise<void> {
  if (tickInflight) return;
  tickInflight = true;
  try {
    await runDueTasks(deps);
  } catch (e) {
    console.warn('[scheduledTasks] tick 异常（吞掉不阻断后续 tick）', e);
  } finally {
    tickInflight = false;
    lastTickAt = Date.now(); // 心跳：tick 跑完（哪怕 runDueTasks 抛）就算调度器活着
  }
}

export async function runDueTasks(deps: SchedulerDeps): Promise<void> {
  const now = deps.now();
  for (const snapshot of await deps.list()) {
    // 时区锚核对在 due 判定之前（G100）：进程时区变了就重算游标 + 换锚，用重算后的任务判到点。
    const retimed = recomputeForTimeZone(snapshot, now);
    const task = retimed ? (await deps.patch(snapshot.id, retimed)) ?? snapshot : snapshot;
    if (!task.enabled || task.nextRunAt == null) continue;
    const lateBy = now - task.nextRunAt;
    if (lateBy < 0) continue; // 未到
    if (lateBy <= GRACE_MS) {
      await fireDueTask(deps, task.id, task.nextRunAt); // 宽限内 → 到点触发
    } else {
      await markMissed(deps, task, now); // 超宽限 → 错过（休眠唤醒积压不当场补跑，G99）
    }
  }
}

/**
 * 到点触发一条任务（宽限内）。dueAt = 判到点时读到的 nextRunAt。
 * await 后重检：按 id 重读，仅当仍 enabled 且 nextRunAt 还等于 dueAt（未被暂停/删除/改时刻）才落账触发。
 * 一次 recordFire 原子写「推进游标 ＋ 记投递账」（G41 · Advance 节点之间无崩溃窗口），随后 spawn 执行体
 * 不 await（G98）——长执行不再拖迟其他任务的到点。
 */
export async function fireDueTask(deps: SchedulerDeps, id: string, dueAt: number): Promise<void> {
  const task = await deps.get(id);
  if (!task || !task.enabled || task.nextRunAt !== dueAt) return;

  // 据当前时刻推进游标（不是 dueAt）：休眠后唤醒未经历重启 reconcile 时，以过去 dueAt 为基点的周期
  // 节奏可能算出仍 ≤ now 的下一个点、被下一轮 tick 当 due 重放。用 now 保证新游标严格未来、至多触发一次。
  // advance 交给 recordFire 在锁内基于最新 cur 算（防覆盖用户在 tick↔落盘间的暂停/改停止条件）。
  const now = deps.now();
  // deferDisable：fire 只推进游标、不当场翻 enabled——once/末次的终态停用延到 settleRun 与计次同源。
  // 否则执行体开跑前重验读到 enabled:false 会把刚 fire 的 once 误判成「已暂停」→ discard 空转（S18 critical）。
  await deps.recordFire(id, { dueAt, firedAt: now }, (cur) => advanceNextRun(cur, now, { deferDisable: true }));
  deps.spawn(id, { manual: false, late: false }); // fire-and-forget：串行合并 / 结算全在执行体内
  await deps.onStateChanged?.();
}

/**
 * 标错过（tick 超宽限 与 reconcile 离线漏跑共用单一口径）：坍缩成最近一次 ≤ now 的触发点、
 * 推进 nextRunAt 到 future（错过的多次不计入次数上限）、不投递、不带「补跑」话术。
 */
async function markMissed(deps: SchedulerDeps, task: ScheduledTask, now: number): Promise<void> {
  const missedAt = collapseMissedToLatest(task, now);
  const next = advanceNextRun(task, now, { countsAsRun: false });
  await deps.patch(task.id, { missedAt, nextRunAt: next.nextRunAt, enabled: next.enabled });
  await deps.onStateChanged?.();
}

/**
 * 用户主动执行 / 错过待处理区「执行」：补跑一次。走同一个执行体入口（manual:true），不记投递账
 * （不是到点的拍——崩溃丢失只是任务页无新 lastRun，不该被对账伪装成「错过」）。missedAt 的清除与
 * 计次由执行体结算处理（§5/§6：late 结算清 missedAt；撞进行中的执行体不另起、立即清 missedAt）。
 * 返回撞上进行中执行体与否，供 RPC 向 UI 提示。
 */
export async function runTaskNow(
  deps: SchedulerDeps,
  id: string,
): Promise<{ alreadyRunning: boolean } | null> {
  const task = await deps.get(id);
  if (!task) return null;
  const late = task.missedAt != null;
  return deps.spawn(id, { manual: true, late });
}

/**
 * 错过待处理区「忽略」：清 missedAt、不投递。
 * 已结束 once（nextRunAt==null）额外标 dismissed:true，让「未能触发」组能写「你已忽略」而非
 * 「设定时间已过」。周期任务忽略后 nextRunAt 仍指向未来、还是 active，给它写「已结束原因」会污染语义，
 * 故只对已结束 once 落。nextRunAt==null 对 once 是终态、不会回翻，get→patch 间这一判定稳定。
 */
export async function dismissMissed(deps: SchedulerDeps, id: string): Promise<void> {
  const task = await deps.get(id);
  const patch: Partial<ScheduledTask> = { missedAt: undefined };
  if (task && task.nextRunAt == null) patch.dismissed = true;
  await deps.patch(id, patch);
  await deps.onStateChanged?.();
}

// ─── 用当前已装配 deps 的便捷入口（router RPC 用，复用 index 注入的真 spawn）──
export async function runScheduledTaskNow(id: string): Promise<{ alreadyRunning: boolean } | null> {
  if (activeDeps) return runTaskNow(activeDeps, id);
  return null;
}
export async function dismissScheduledMissed(id: string): Promise<void> {
  if (activeDeps) await dismissMissed(activeDeps, id);
}

/**
 * 启动对账：两件事——
 * ①收编「已投递未结算」的残留账（S18·G41 崩溃窗口）：上次投递后崩在结算前的拍，按重验标错过或静默销账；
 * ②离线期错过（G99）：停机/休眠错过且超宽限的触发不自动补跑（避免补出过时内容），坍缩成最近一次标
 *   missedAt 进「错过待处理」区由用户决定，并把 nextRunAt 推进到 future。落后在宽限内的留给首 tick
 *   正常触发（与 tick 同一口径，两处从此不再各判一套）。
 */
export async function reconcileOnBoot(deps: SchedulerDeps): Promise<void> {
  const now = deps.now();
  for (const task of await deps.list()) {
    if ((task.pendingFires ?? []).length > 0) {
      await deps.reconcileFires(task.id);
      await deps.onStateChanged?.();
    }
    if (!task.enabled || task.nextRunAt == null) continue;
    if (now - task.nextRunAt <= GRACE_MS) continue; // 宽限内：留给首 tick 正常触发
    await markMissed(deps, task, now);
  }
}
