/**
 * 对外投递判定内核（S04 投递档）——判定单源，两个消费方：
 *   - web_fetch / bash 用「用户逐字地址」判定决定是否免闸（approval.html「看地址的来历」）；
 *   - S24 用 deliveryGrantKey / deliveryScope 做「始终允许」持久授权（渠道＋收件人粒度）——
 *     免卡判定改查持久授权清单（isGranted），会话级过渡记忆已随 S24 落地移除。
 *
 * 「逐字」纪律：大小写敏感的子串匹配，唯一放宽是同时取去掉 http(s):// 前缀的形态
 * （用户粘贴地址常不带 scheme；host+path+query 仍须完整逐字）。模型在用户地址后追加
 * 参数即不逐字、自然过卡——这正是「参数可外带数据」要挡的形态。
 */
import type { ChatMessage, DeliveryTarget, GrantScope } from '@shared/types';
import { readHistory } from '../../conversations/store';

/** 本对话中「用户本人消息」的文本：role=user 且非系统合成 kind（proposal/task-report 等）。
 *  渠道来的消息按现状「配对绑定即本人」算用户本人；群聊（G06）落地时需按发话人区分。 */
function userTexts(history: ChatMessage[]): string[] {
  return history.filter((m) => m.role === 'user' && m.kind === undefined).map((m) => m.text);
}

/** 全部地址逐字出现在本对话用户消息里才算 pinned（合取；空地址列表恒 false——提不出地址不免闸）。 */
export async function addressesPinnedByUser(
  addresses: string[],
  agentId: string,
  conversationId: string,
): Promise<boolean> {
  if (addresses.length === 0) return false;
  const history = await readHistory(agentId, conversationId).catch(() => [] as ChatMessage[]);
  const texts = userTexts(history);
  return addresses.every((a) => {
    const needles = [a, a.replace(/^https?:\/\//i, '')].filter((n) => n.length > 0);
    return texts.some((t) => needles.some((n) => t.includes(n)));
  });
}

/** web_fetch 用：地址逐字来自用户 → 按只读放行；否则给出投递目标（host 即 S24 收件人）。 */
export async function judgeUrl(
  url: string,
  agentId: string,
  conversationId: string,
): Promise<{ userPinned: true } | { userPinned?: undefined; target: DeliveryTarget }> {
  if (await addressesPinnedByUser([url], agentId, conversationId)) return { userPinned: true };
  return { target: { channel: 'web', recipient: hostOf(url), label: url } };
}

/**
 * S24「始终允许」的记忆键：`渠道:收件人`；收件人提不出（null）→ 不可持久授权。
 * 生产暂无直接调用（现行授权键经 shared/proposals/grantKey.ts 的 delivery scope 生成）——
 * 这是 S04 定死、留给外发持久授权后续消费的接口，别当死码清掉（2026-07-13 清理审计注记）。
 */
export function deliveryGrantKey(t: DeliveryTarget): string | null {
  return t.recipient ? `${t.channel}:${t.recipient}` : null;
}

/**
 * 投递目标 → 可持久授权的 delivery scope（S24 · G30）；收件人提不出（null）→ null（不可持久授权，
 * 该目标永远弹卡）。构造方据此拼 proposal.grantable，emit 端查 isGranted 决定免卡。
 */
export function deliveryScope(t: DeliveryTarget): GrantScope | null {
  return t.recipient ? { kind: 'delivery', channel: t.channel, recipient: t.recipient } : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}
