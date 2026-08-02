/**
 * 后台 / 无界面 runConversation 调用的初始 history：把一段 prompt 包成单条 user 消息。
 *
 * 为什么需要它：`ConversationInput` 的契约是「当前 user 轮 = history 末尾的 user 消息」
 * （见 shared/agent/backend.ts 字段注释）。只有 claudeCode 后端会兜底读 `input.userMessage`；
 * anthropic / openaiCompatible 只 replay `history`、忽略 userMessage。后台调用（dream 复盘 /
 * 背景查询 / loop 编排 / subagent 派工）没有既有会话，必须显式把 prompt 作为 history 的唯一
 * user 轮传入——否则在非 claudeCode 后端上 prompt 被静默丢弃，模型只收到 system prompt。
 *
 * 主对话路径不用它：runner.ts 在起流前已 appendMessage 把本轮 user 落进 history。
 */
import type { ChatAttachment, ChatMessage } from '@shared/types';
import { newMessageId } from '@shared/ids';

/**
 * 裸 user 轮的唯一构造点——singleUserTurn 与 ensureCurrentTurnInHistory 共用，字段不手抄第二份。
 * attachments 可选：后台调用要带图时挂上它（loop 拆解带 /loop 消息的图），三后端的既有图通道
 * 自动生效（HTTP 经 historyAdapter 出 image block，claudeCode 经 currentTurnImageAttachments
 * 取 history 末条 user）。
 */
export function makeUserTurn(conversationId: string, text: string, attachments?: ChatAttachment[]): ChatMessage {
  return {
    id: newMessageId(),
    conversationId,
    role: 'user',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    attachments,
  };
}

export function singleUserTurn(
  conversationId: string,
  text: string,
  attachments?: ChatAttachment[],
): ChatMessage[] {
  return [makeUserTurn(conversationId, text, attachments)];
}
