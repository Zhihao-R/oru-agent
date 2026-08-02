/**
 * 定时任务调度纯函数——无副作用、注入时钟。
 *
 * 第一性：触发节奏只是计算输入，统一归一成一个绝对时间戳 nextRunAt。本模块是
 * 「spec → 绝对时刻」的唯一换算处，调度器 / store / UI 预览 / AI 工具校验全部复用，
 * 不在别处重写时刻推算（单一事实来源）。
 *
 * 时刻计算一律走 Date 组件构造（new Date(y, m, d, h, min)），天然处理月/年溢出与本地
 * 夏令时，不靠「+24h 毫秒」这种 DST 会错的算术。interval 例外——它是与挂钟无关的等差
 * 网格（从 createdAt 起每 every 个单位），用毫秒算术即可。
 */
import type { ScheduleSpec, ScheduledTask } from '@shared/types';

/** 触发间隔下限：1 分钟。UI 与 AI 工具走同一口径（见 validateSpec）。 */
export const MIN_INTERVAL_MS = 60_000;

/**
 * 进程当前 IANA 时区名（S18·G100 时区锚）。创建任务时记录、tick 前核对。
 * 拿不到（罕见环境无 Intl 数据）回落 'UTC'——锚有值即可，重算逻辑对 UTC 无害。
 */
export function currentTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface NextRun {
  nextRunAt: number | null;
  enabled: boolean;
}

/** 某天（以 ref 的本地日期为基准、加 dayOffset 天）的 minutesOfDay 时刻。 */
function dateAtMinutes(ref: Date, dayOffset: number, minutesOfDay: number): number {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + dayOffset, h, m, 0, 0).getTime();
}

/** interval 的步长（毫秒）：分钟×60s / 小时×3600s；至少 1ms 防死循环。 */
function intervalStepMs(spec: { every: number; unit: 'minute' | 'hour' }): number {
  const unitMs = spec.unit === 'hour' ? 3_600_000 : 60_000;
  return Math.max(1, Math.floor(spec.every) * unitMs);
}

/**
 * 严格大于 after 的下一个触发时刻；无下次（一次性已过）返回 null。
 * createdAt 仅 interval 用——它是以 createdAt 为原点的等差网格，重启/编辑后据此稳定重算。
 */
export function computeNextRun(spec: ScheduleSpec, after: number, createdAt: number): number | null {
  switch (spec.kind) {
    case 'once':
      return spec.at > after ? spec.at : null;

    case 'daily': {
      const ref = new Date(after);
      const today = dateAtMinutes(ref, 0, spec.minutesOfDay);
      return today > after ? today : dateAtMinutes(ref, 1, spec.minutesOfDay);
    }

    case 'weekly': {
      const ref = new Date(after);
      for (let i = 0; i <= 7; i++) {
        const cand = dateAtMinutes(ref, i, spec.minutesOfDay);
        if (cand > after && spec.weekdays.includes(new Date(cand).getDay())) return cand;
      }
      return null; // weekdays 空才会到这（validateSpec 已挡），防御性返回
    }

    case 'interval': {
      const step = intervalStepMs(spec);
      // 网格点 = createdAt + k·step（k≥1，首个触发点不含 createdAt 自身）；取严格大于 after 的最小者
      const k = Math.max(1, Math.floor((after - createdAt) / step) + 1);
      return createdAt + k * step;
    }
  }
}

/** 小于等于 at 的最近一个触发时刻（用于把错过的多次坍缩成最近一次）。 */
function latestTriggerAtOrBefore(spec: ScheduleSpec, at: number, createdAt: number): number {
  switch (spec.kind) {
    case 'once':
      return spec.at;
    case 'daily': {
      const ref = new Date(at);
      const today = dateAtMinutes(ref, 0, spec.minutesOfDay);
      return today <= at ? today : dateAtMinutes(ref, -1, spec.minutesOfDay);
    }
    case 'weekly': {
      const ref = new Date(at);
      for (let i = 0; i <= 7; i++) {
        const cand = dateAtMinutes(ref, -i, spec.minutesOfDay);
        if (cand <= at && spec.weekdays.includes(new Date(cand).getDay())) return cand;
      }
      return at;
    }
    case 'interval': {
      const step = intervalStepMs(spec);
      // ≤ at 的最大网格点：floor 即正确（调用方保证 at ≥ createdAt+step，故 k≥1）；不抬 max 以维持「≤」语义
      const k = Math.floor((at - createdAt) / step);
      return createdAt + k * step;
    }
  }
}

/**
 * fire / reconcile 后算下一个调度游标 + 是否因停止条件而停用。
 * - once → 无下次。
 * - countsAsRun（默认 true，正常 fire）：本次计入 runCount，命中 stopAfterRuns 即停。
 *   reconcile 补漏 / 手动·补执行时传 false——这些不计入次数上限（手动执行不耗自动停止配额）。
 * - deferDisable（fire 路径传 true）：只推进游标、**不当场翻 enabled**，把「用尽即停用」延到结算单点
 *   （store.settleRun）与 runCount+1 同源。fire 先翻 enabled 会让执行体开跑前重验把它误判成「用户
 *   已暂停」→ discardFires 空转，一次性任务 100% 到点不执行（S18 critical）。enabled 的两层含义
 *   （用户开关 vs 用尽终态）必须分开：执行期间保持「用户开关」语义，终态收敛到 settle。
 */
export function advanceNextRun(
  task: Pick<ScheduledTask, 'spec' | 'runCount' | 'stopAfterRuns' | 'enabled' | 'createdAt'>,
  now: number,
  opts?: { countsAsRun?: boolean; deferDisable?: boolean },
): NextRun {
  const countsAsRun = opts?.countsAsRun ?? true;
  const deferDisable = opts?.deferDisable ?? false;
  // 一次无下次。真正跑过（fire 路径 countsAsRun:true）→ 停用（与 stopAfterRuns 到顶对称）；
  // reconcile 补漏（countsAsRun:false，没真跑）→ 保留 enabled，让它以「错过待处理」状态等用户决定，
  // 不能擅自停用（否则 missed 的一次任务被标成已停用，状态与「待你拍板」矛盾）。
  // deferDisable（fire）→ 一律保留 enabled，停用交给 settle。
  if (task.spec.kind === 'once') {
    return { nextRunAt: null, enabled: countsAsRun && !deferDisable ? false : task.enabled };
  }
  const effectiveRuns = task.runCount + (countsAsRun ? 1 : 0);
  if (countsAsRun && task.stopAfterRuns != null && effectiveRuns >= task.stopAfterRuns) {
    return { nextRunAt: null, enabled: deferDisable ? task.enabled : false };
  }

  const next = computeNextRun(task.spec, now, task.createdAt);
  return { nextRunAt: next, enabled: task.enabled };
}

/**
 * 「跑过这一拍后是否用尽即终态停用」——once 跑过即停；stopAfterRuns 到顶即停。
 * fire 路径经 deferDisable 推迟了停用，结算单点（store.settleRun）据此翻 enabled，与 runCount+1 同源。
 * newRunCount 传本次结算后的计次（settle 已 +1）。
 */
export function isSpentAfterRun(
  task: Pick<ScheduledTask, 'spec' | 'stopAfterRuns'>,
  newRunCount: number,
): boolean {
  if (task.spec.kind === 'once') return true;
  return task.stopAfterRuns != null && newRunCount >= task.stopAfterRuns;
}

/**
 * 时区锚核对（S18·G100）——进程当前时区与任务锚不符时算出应落的新游标 + 新锚。返回 null = 时区未变、无需动。
 * - daily/weekly：挂钟相对任务，据进程当前时区重算 nextRunAt（computeNextRun 用本地 Date 构造，按新时区算）；
 * - once（绝对时刻）/ interval（等差网格）：与挂钟无关，nextRunAt 不变，只换锚。
 * DST 切换不改 IANA 时区名、不触发本函数（Date 构造本就处理 DST）。停用 / 无下次的任务只换锚不动游标。
 */
export function recomputeForTimeZone(
  task: Pick<ScheduledTask, 'spec' | 'tz' | 'nextRunAt' | 'enabled' | 'createdAt'>,
  now: number,
): { nextRunAt: number | null; tz: string } | null {
  const tz = currentTimeZone();
  if (task.tz === tz) return null;
  const wallClockBound = task.spec.kind === 'daily' || task.spec.kind === 'weekly';
  const nextRunAt =
    wallClockBound && task.enabled && task.nextRunAt != null
      ? computeNextRun(task.spec, now, task.createdAt)
      : task.nextRunAt;
  return { nextRunAt, tz };
}

/**
 * 把错过的多次触发坍缩成最近一个 ≤ now 的触发点（错过待处理区每任务只一条，不堆叠）。
 * 一次返回原定时刻。
 */
export function collapseMissedToLatest(
  task: Pick<ScheduledTask, 'spec' | 'nextRunAt' | 'createdAt'>,
  now: number,
): number {
  if (task.spec.kind === 'once') return task.nextRunAt ?? task.spec.at;
  return latestTriggerAtOrBefore(task.spec, now, task.createdAt);
}

// 频率人话描述放 shared（主进程 + 渲染端共用一份），此处再导出便于本模块内/既有 import 复用
export { describeSpec, describeFrequency } from '@shared/scheduledTasks/describe';

/** 接下来 count 个触发时刻（「将于…首次触发」确认语句复用此处）。createdAt 仅 interval 用。 */
export function previewNextRuns(spec: ScheduleSpec, now: number, count: number, createdAt: number): number[] {
  const out: number[] = [];
  let cursor = now;
  for (let i = 0; i < count; i++) {
    const next = computeNextRun(spec, cursor, createdAt);
    if (next == null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

function assertMinutesOfDay(m: number): void {
  if (!Number.isInteger(m) || m < 0 || m > 1439) throw new Error('时刻需为 0..1439 的分钟数');
}

/** "YYYY-MM-DD HH:MM"（本地）——assertCreatable 诊断 message 与 once 提案描述共用一处绝对时刻格式化。 */
export function fmtLocal(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 未来时刻闸：一次性任务时刻须严格未来，否则 throw（兜底，即便换算还有别的疏漏，也不会再
 * 生出「一出生就已结束」的提醒）。message 带「填入时刻 + 当前时间 + 导向」供模型重设（tech §D）。
 *
 * 第一性：与 validateSpec 是两个不同问题——validateSpec 管「结构是否合法」（与时间无关、纯函数无 now），
 * 此函数管「时刻是否未过」（相对 now）。故拆成两个函数、装在不同调用点（写入边界，不含 preview）：
 * 「过去的 once」结构上完全合法（所有已结束一次性任务都是这形态），塞进 validateSpec 会误伤
 * 实时预览与已落盘任务。
 */
export function assertCreatable(spec: ScheduleSpec, now: number): void {
  if (spec.kind === 'once' && spec.at <= now) {
    throw new Error(
      `你设定的时刻 ${fmtLocal(spec.at)} 已经过去（现在是 ${fmtLocal(now)}）。` +
        `请确认日期后重设；若用户指的是今天/明天，请按当前日期重新计算。`,
    );
  }
}

/**
 * 校验 spec 合法且触发间隔不低于下限。UI 与 AI 工具的 create/update 走同一函数
 * （单一事实来源——模型与界面受同一护栏约束）。非法即 throw。
 */
export function validateSpec(spec: ScheduleSpec): void {
  switch (spec.kind) {
    case 'once':
      if (!Number.isFinite(spec.at)) throw new Error('一次性任务的时间无效');
      return;
    case 'daily':
      assertMinutesOfDay(spec.minutesOfDay);
      return;
    case 'weekly':
      assertMinutesOfDay(spec.minutesOfDay);
      if (!Array.isArray(spec.weekdays) || spec.weekdays.length === 0) {
        throw new Error('每周任务至少要选一天');
      }
      if (spec.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        throw new Error('星期取值需在 0..6（0=周日）');
      }
      return;
    case 'interval': {
      if (!Number.isInteger(spec.every) || spec.every < 1) {
        throw new Error('「每隔 N」的 N 需为 ≥1 的整数');
      }
      if (spec.unit !== 'minute' && spec.unit !== 'hour') throw new Error('间隔单位需为分钟或小时');
      if (intervalStepMs(spec) < MIN_INTERVAL_MS) throw new Error('触发间隔不得低于 1 分钟');
      return;
    }
  }
}
