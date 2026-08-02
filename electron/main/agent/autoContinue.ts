/**
 * 断线自动接续预算（S25 · G23/G03）——error-retry.html#M3「说到一半断了·自动接续」。
 *
 * 流已开后遭遇可重试的上游故障时，系统自动触发一次前缀续写（复用手动 [重试] 的 maybeResumeTurn），
 * 不再只落半截等用户手点。为防上游持续抖动时无限续写，一条对话连续自动续写有次数上限；成功跑完
 * 一轮 / 用户发新消息 / 用户按停都重置预算，让后续断线重获满额。
 *
 * 计数只在内存（跨重启即重置，符合「瞬时故障」语义——重启后本就该重新计）；键为 conversationId。
 */

/** 一条对话连续自动续写的次数上限（error-retry.html 明言「接续同样有次数上限」）。 */
export const MAX_AUTO_CONTINUE = 3;

const attempts = new Map<string, number>();

/**
 * 预看下一次续写会是第几次（1..MAX，供「正在重试 n/N」提示与「够不够格续写」判定），**不消费**。
 * 预算用尽返回 null。判定与消费分离（decide-then-run）：断线当下用它决定是否抑制红条并调度续写，
 * 真正起跑时才 claimAutoContinue 消费——调度若被并发抢轮跳过，预算不白扣（S25 review M2）。
 */
export function peekAutoContinue(conversationId: string): number | null {
  const next = (attempts.get(conversationId) ?? 0) + 1;
  return next > MAX_AUTO_CONTINUE ? null : next;
}

/** 消费一次续写配额（续写轮真正起跑时调）——计数 +1。 */
export function claimAutoContinue(conversationId: string): void {
  attempts.set(conversationId, (attempts.get(conversationId) ?? 0) + 1);
}

/** 重置预算——成功收尾 / 用户发新消息 / 用户按停时调，让后续断线重获满额自动续写。 */
export function resetAutoContinue(conversationId: string): void {
  attempts.delete(conversationId);
}
