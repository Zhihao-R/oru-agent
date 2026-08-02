/**
 * 「处理中」表情登记表（S10 · §6）——markProcessing 语义从「回合在跑」改为「这条消息还没处理完」：
 * 统一排队后消息可能在队里等一阵，表情要跟着**消息**走，不跟回合走。
 *
 * 入站即贴（gateway 层，现状不变）→ 在此按 (platform, chatId, platformMessageId) 登记「怎么清」的闭包
 * （闭包捕获 adapter.clearProcessing + handle）。清除的发起方都在统一回合装配：
 * - 消费该消息的回合出站完成时（deliverAssistantToChannels 之后按本回合消费集逐条清）；
 * - 消息被交还 / 清掉时（onHandback 路径）。
 * 没有这两条回调，交还或已消费消息的表情会永远挂着。按 origin 精确清，保证同 chat 还在排队的
 * 其他消息表情不被误清。
 */
import type { TriggerOrigin } from '@shared/types';

const clears = new Map<string, () => Promise<void>>();

function keyOf(o: TriggerOrigin): string {
  return `${o.platform}:${o.chatId}:${o.platformMessageId}`;
}

/** gateway 贴表情成功后登记清除闭包（handle 非 null 时才登记）。 */
export function registerProcessing(o: TriggerOrigin, clear: () => Promise<void>): void {
  clears.set(keyOf(o), clear);
}

/** 清除某条消息的「处理中」表情（消费出站完成 / 交还 / 清掉时调）；未登记则 no-op。幂等。 */
export async function clearProcessing(o: TriggerOrigin): Promise<void> {
  const clear = clears.get(keyOf(o));
  if (!clear) return;
  clears.delete(keyOf(o));
  await clear().catch((e) => console.warn('[platform] 清除处理中表情失败（忽略）:', e));
}

/**
 * 一批消息离开处理管线（交还 / 清掉 / 回合中断故障未消费出站）时清各自表情的单一收口——
 * 「有 origin 的逐条 clearProcessing」这条不变量只此一处，各交还点调它、别各写各的（S10 review · m1）。
 * fire-and-forget：清表情是非承重副作用，不阻塞调用方。
 */
export function clearProcessingForItems(items: { origin?: TriggerOrigin }[]): void {
  for (const { origin } of items) if (origin) void clearProcessing(origin);
}
