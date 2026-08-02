/**
 * 飞书「处理中」表情纯 helper（tech design §B）——收到消息贴 OnIt 表情表「在处理」，完成后移除。
 * 与 adapter 的 SDK glue 分离，便于单测（用 Pick<ReactionApi> 最小 fake）。
 *
 * 容错纪律：表情只是轻量反馈，贴 / 删失败都不该影响主流程——贴失败返回 null、删失败逐个吞掉继续。
 */
import type * as Lark from '@larksuiteoapi/node-sdk';

/** 飞书消息表情回复 API（im.messageReaction）——Pick 透传真实 SDK 类型，不手写签名。 */
export type ReactionApi = Lark.Client['im']['messageReaction'];

/** OnIt = 飞书「在处理」表情（§B 时序）。 */
const PROCESSING_EMOJI = 'OnIt';

/** 给消息贴 OnIt 表情，取回 reaction_id 供后续精确删除；任何失败返回 null（不崩 turn）。 */
export async function addOnItReaction(api: Pick<ReactionApi, 'create'>, messageId: string): Promise<string | null> {
  try {
    const res = await api.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: PROCESSING_EMOJI } },
    });
    return res.data?.reaction_id ?? null;
  } catch {
    return null;
  }
}

/** 逐个删除 Oru 在该消息上贴的 reaction（只删传入的 id）；单个失败不影响其余。 */
export async function removeReactions(
  api: Pick<ReactionApi, 'delete'>,
  messageId: string,
  reactionIds: string[],
): Promise<void> {
  for (const reactionId of reactionIds) {
    try {
      await api.delete({ path: { message_id: messageId, reaction_id: reactionId } });
    } catch {
      // 尽力清干净，单个删失败吞掉继续
    }
  }
}
