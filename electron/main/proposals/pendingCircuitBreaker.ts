/**
 * 断路器跳闸的用户决定信箱（G01/G04）——与 pendingUserChoice / pendingDecision 同构。
 *
 * 断路器跳闸后 executeAgentTool 先按 breakerId 挂 waiter、再 emit 跳闸卡、再 await——工具执行
 * 就地挂起等用户点「继续放行 / 停止」。router 的 chat.circuitBreakDecision 调 settle 唤醒。
 *
 * abort（用户刹车 / 回合报错）经 signal 自动 reject → 上层当「停止」处理，不留死 deferred。
 */
export type BreakerDecision = 'resume' | 'stop';

const waiters = new Map<string, { resolve: (d: BreakerDecision) => void; reject: (e: Error) => void }>();

/** 挂起等某次跳闸的用户决定。注册同步完成，调用方应在 await 前 emit 卡片。signal abort → reject。 */
export function awaitBreakerDecision(breakerId: string, signal: AbortSignal): Promise<BreakerDecision> {
  return new Promise<BreakerDecision>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('对话已取消'));
      return;
    }
    const cleanup = (): boolean => {
      if (!waiters.has(breakerId)) return false;
      waiters.delete(breakerId);
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (cleanup()) reject(new Error('对话已取消'));
    };
    waiters.set(breakerId, {
      resolve: (d) => {
        if (cleanup()) resolve(d);
      },
      reject: (e) => {
        if (cleanup()) reject(e);
      },
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 用户点「继续放行 / 停止」时唤醒等待者。返回 true=确有工具在等。 */
export function settleBreaker(breakerId: string, decision: BreakerDecision): boolean {
  const w = waiters.get(breakerId);
  if (!w) return false;
  w.resolve(decision);
  return true;
}

/** 派发失败（emit 卡抛错）时主动 reject 清 waiter，避免死 deferred。 */
export function abortBreaker(breakerId: string): void {
  waiters.get(breakerId)?.reject(new Error('断路器跳闸卡派发失败'));
}
