/**
 * 渠道出站面（S10 · §4）——回发从「回合闭包」解绑为「出站面 + 判据函数」两件套，让回复对
 * 「谁起的回合」完全不敏感：桌面起的回合中途插入了一条飞书消息，回复照发回飞书。
 *
 * - deliverToChannel：脱敏 + adapter.send 收敛于此（平移基线 = S05 落地后的 gatewayWiring 回发段：
 *   redactSecrets + adapter 内 sendWithRetry + SendResult 失败留痕，行为逐项保留）。S26 送达内核
 *   收口时只换实现、签名不变。adapter 按平台从注册表取（platformManager 连接时注册、断开时注销）。
 * - resolveOutboundTargets：本回合的回复该回发给谁。S10 只实现「触发来源」一路——inputs 含渠道
 *   origin → 回发到这些 (platform, chatId)（去重）；纯桌面输入 → 空、不回发（现状语义）。绑定判据
 *   （G33 桌面发言 / 定时产出也回发）留给 S11 在同一函数上扩展（conversation 参数为其预留）。
 */
import type { Platform, SendResult } from '@shared/platform/message';
import type { Conversation, TriggerOrigin } from '@shared/types';
import { redactSecrets } from './redact';

export type ChannelAddress = { platform: Platform; chatId: string };

/** 平台出站发送器（= adapter.send 的 (chatId, text) 偏函数）。 */
type ChannelSender = (chatId: string, text: string) => Promise<SendResult>;

const senders = new Map<Platform, ChannelSender>();

/** platformManager 连接一个平台时注册其发送器；断开时注销（成对清理）。 */
export function registerChannelSender(platform: Platform, sender: ChannelSender): void {
  senders.set(platform, sender);
}
export function unregisterChannelSender(platform: Platform): void {
  senders.delete(platform);
}

/**
 * 送达一段回复到某渠道地址：脱敏后经该平台的注册发送器发出（其内含 S05 的重发与失败留痕）。
 * 平台未连接（无注册发送器）→ 返回失败留痕、不抛（回发是非承重副作用，缺连接不该崩回合）。
 * 空文本不发（与旧回发段一致）。
 */
export async function deliverToChannel(addr: ChannelAddress, text: string): Promise<SendResult> {
  const redacted = redactSecrets(text ?? '');
  if (!redacted.trim()) return { ok: true };
  const sender = senders.get(addr.platform);
  if (!sender) {
    const error = `no live ${addr.platform} connection to deliver`;
    console.warn(`[platform] ${error}`);
    return { ok: false, error };
  }
  const res = await sender(addr.chatId, redacted);
  if (!res.ok) {
    console.warn(`[platform] ${addr.platform} 回发投递失败（${res.failure ?? 'permanent'}）:`, redactSecrets(res.error ?? ''));
  }
  return res;
}

/**
 * 本回合的回复回发目标（S10「触发来源」一路）：inputs 是本回合消费的全部新输入的 origin 投影
 * （起回合那条 + 间隙插入批）。含渠道 origin → 回发到这些 (platform, chatId)、去重；纯桌面 → 空。
 * conversation 供 S11 扩展「对话绑定判据」，本期不读。
 */
export function resolveOutboundTargets(
  inputs: { origin?: TriggerOrigin }[],
  _conversation: Conversation,
): ChannelAddress[] {
  const seen = new Set<string>();
  const out: ChannelAddress[] = [];
  for (const { origin } of inputs) {
    if (!origin) continue;
    const key = `${origin.platform}:${origin.chatId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ platform: origin.platform, chatId: origin.chatId });
  }
  return out;
}
