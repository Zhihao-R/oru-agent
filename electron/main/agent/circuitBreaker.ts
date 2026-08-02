/**
 * 工具断路器（G01/G04）——像电闸过载跳闸：一个回合里工具调用**异常频繁**或**连续失败**时
 * 自动暂停，防止失控循环无声烧钱 / 反复写盘。灾难级命令的硬拦是另一道闸（isCatastrophic），
 * 二者旁站：硬拦管「这条命令绝对不能跑」，断路器管「这个循环已经失控」。
 *
 * 本文件只做**检测**（纯状态机，好测）。跳闸后的「弹卡问用户 [继续放行]/[停止]」编排 + 信箱在
 * circuitBreakerGuard.ts；跳闸卡的渲染在前端。按对话（conversationId）计，一个回合一份状态。
 *
 * 阈值刻意保守（PM 拍板：先不误拦正常的密集操作，可后续调）：
 *  - 连续失败：一连 CONSEC_FAILURE_LIMIT 次工具回执都是错，判失控（卡在原地反复重试的典型信号）。
 *  - 调用频率：滚动 RATE_WINDOW_MS 窗口内累计 RATE_LIMIT 次调用，判异常频繁。
 * 任一命中即跳闸。用户点「继续放行」→ reset 清零接着跑；点「停止」→ 刹停本回合。
 */

/** 连续失败上限——一连这么多次工具回执都是 isError 即判失控。 */
export const CONSEC_FAILURE_LIMIT = 6;
/** 频率窗口（毫秒）。 */
export const RATE_WINDOW_MS = 30_000;
/** 频率上限——RATE_WINDOW_MS 内累计这么多次工具调用即判异常频繁。 */
export const RATE_LIMIT = 40;

export type TripReason = 'consecutive-failures' | 'high-frequency';

type BreakerState = {
  /** 滚动窗口内的调用时刻（毫秒），老的按 RATE_WINDOW_MS 汰换。 */
  callTimes: number[];
  /** 当前连续失败计数（任一成功清零）。 */
  consecutiveFailures: number;
};

const states = new Map<string, BreakerState>();

function ensure(convId: string): BreakerState {
  let s = states.get(convId);
  if (!s) {
    s = { callTimes: [], consecutiveFailures: 0 };
    states.set(convId, s);
  }
  return s;
}

/** 记一次工具调用（执行前调）。返回汰换后的窗口内计数，纯副作用登记。 */
export function noteToolCall(convId: string, now: number): void {
  const s = ensure(convId);
  s.callTimes.push(now);
  const cutoff = now - RATE_WINDOW_MS;
  // 窗口左沿汰换：callTimes 单调递增，从头删到第一个 >= cutoff。
  let drop = 0;
  while (drop < s.callTimes.length && s.callTimes[drop] < cutoff) drop += 1;
  if (drop > 0) s.callTimes.splice(0, drop);
}

/** 记一次工具回执（执行后调）。isError 累加连续失败，成功清零。 */
export function noteToolResult(convId: string, isError: boolean): void {
  const s = ensure(convId);
  s.consecutiveFailures = isError ? s.consecutiveFailures + 1 : 0;
}

/**
 * 依当前状态判是否该跳闸（在 noteToolCall 之后、执行工具之前调）。
 * 返回跳闸原因，或 null（不跳）。频率与连续失败任一命中即跳。
 */
export function evaluateTrip(convId: string): TripReason | null {
  const s = states.get(convId);
  if (!s) return null;
  if (s.consecutiveFailures >= CONSEC_FAILURE_LIMIT) return 'consecutive-failures';
  if (s.callTimes.length >= RATE_LIMIT) return 'high-frequency';
  return null;
}

/** 清零本对话的断路器状态——用户点「继续放行」后，或回合收尾时。 */
export function resetBreaker(convId: string): void {
  states.delete(convId);
}

/** 仅测试用：清空全部状态。 */
export function __clearBreakersForTest(): void {
  states.clear();
}
