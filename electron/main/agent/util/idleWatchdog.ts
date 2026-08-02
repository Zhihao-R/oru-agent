/**
 * 事件流空闲看门狗——多轮 agent 后台调用（会自主调工具、时长不可预知）的统一超时原语。
 *
 * 超时要检测的是「没有进展」，而进展信号因调用形状而异，全仓分三层各管各的：
 *   - 多轮 agent 事件流（dream / 背景 Twin）：进展 = 事件（工具调用、流式增量）——用本工具，
 *     事件间静默超过 idleMs 才触发 onIdle（接 abort）。还在干活永不杀，只杀卡死；
 *     总时长硬杀对这类调用是错误度量——积压大的正常运行会在收尾总结前被误杀
 *     （dream 2026-07-27 三连超时即此）。
 *   - one-shot 单次调用（autoName / compress / loop 审查）：无中间事件、时长有确定上界——
 *     总时长硬超时是正确语义（runOneShotWithTimeout），不用本工具。
 *   - 单条 HTTP 流的 chunk 级空闲：网络层 readWithIdleTimeout（retry.ts）负责。
 *
 * 交互式主对话不设自动超时——用户就是看门狗，有停止按钮。
 */

/** 静默判死阈值：容忍最慢的合法事件间隔（首 token 延迟、重试退避、长工具执行），跨调用方共用 */
export const STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * 透传事件流，事件间静默超过 idleMs 就调一次 onIdle（一般接 abort）。
 * 每个事件到达重置计时；计时器与迭代同生命周期，finally 里清理。
 * 注意：async generator 惰性——计时从首次迭代开始，不是从调用本函数开始。
 */
export async function* withIdleWatchdog<T>(
  events: AsyncIterable<T>,
  idleMs: number,
  onIdle: () => void,
): AsyncIterable<T> {
  let timer = setTimeout(onIdle, idleMs);
  try {
    for await (const ev of events) {
      clearTimeout(timer);
      timer = setTimeout(onIdle, idleMs);
      yield ev;
    }
  } finally {
    clearTimeout(timer);
  }
}
