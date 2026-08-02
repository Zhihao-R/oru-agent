/**
 * 出站重发内核（理想架构 S05）——error-retry「送达」的拍板口径落地：
 * 只有能保证「恢复不产生重复后果」的失败才自动重发，其余交出去由上层感知。
 *
 *  - transient（明确拒绝且瞬时）：退避后重发一次，任何平台都安全；
 *  - unknown（结果未知，请求可能已送达）：仅当平台按幂等键去重（飞书 message.create 的 uuid）
 *    才重发；无幂等键的平台（Discord）一律不盲重发——防「发没发出去未知」变成双发；
 *  - permanent（鉴权 / 参数错）：从不重发。
 *
 * 两个平台 adapter 共用这一套，重发策略不再各写各的。
 */
import type { SendFailure, SendResult } from '@shared/platform/message';

/**
 * 把发送抛出的错误归入失败三态。优先看 HTTP 响应码（AxiosError / discord.js 错误都带）：
 * 有响应码说明平台收到并明确答复——429 瞬时拒收、5xx 服务端故障（是否已处理未知）、
 * 其余 4xx 永久。无响应码看错误串：连接未建立（请求根本没发出）算 transient，
 * 超时 / 连接中断（请求可能已送达）算 unknown，认不出的一律 permanent（不猜、不重发）。
 */
export function classifySendFailure(e: unknown): SendFailure {
  const status = (e as { response?: { status?: number } })?.response?.status ?? (e as { status?: number })?.status;
  if (status === 429) return 'transient';
  if (typeof status === 'number' && status >= 500) return 'unknown';
  if (typeof status === 'number' && status >= 400) return 'permanent';
  const s = String(e);
  if (/\b429\b|rate.?limit|ECONNREFUSED|EAI_AGAIN/i.test(s)) return 'transient';
  if (/ETIMEDOUT|ECONNRESET|EPIPE|timeout|socket hang up|\b50\d\b/i.test(s)) return 'unknown';
  return 'permanent';
}

/** 一次发送 + 按失败三态最多一次重发（重发前退避）。 */
export async function sendWithRetry(
  sendOnce: () => Promise<SendResult>,
  opts: { idempotent: boolean; backoff: () => Promise<void> },
): Promise<SendResult> {
  const res = await sendOnce();
  if (res.ok) return res;
  const retriable = res.failure === 'transient' || (res.failure === 'unknown' && opts.idempotent);
  if (!retriable) return res;
  await opts.backoff();
  return sendOnce();
}
