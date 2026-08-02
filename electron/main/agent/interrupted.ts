/**
 * 中断回合恢复：承载"被打断的半截"并据此构造要落盘的 incomplete assistant 消息。
 *
 * - runner 在中断（用户 abort / 上游挂死）时，把 InterruptedTurn 作为数据**挂在原错误上**
 *   （`err.interruptedTurn`），不替换错误本身——报错/分类路径一字不改。
 * - runChatAndPersist 的 catch 读出它，用 buildInterruptedMessage 落成一条 incomplete 历史消息。
 * 设计见 docs/tech/2026-06-05-interrupted-turn-recovery-tech-design.md §1-§3。
 */
import type { BackendType, ChatMessage, ToolCall, ToolProtocol } from '@shared/types';

export type InterruptReason = 'aborted' | 'upstream_error' | 'crashed';

/** 断点前已成形的产出：流式文字 + 已发起的工具调用（含悬空，即无 result 的）。 */
export type PartialTurn = { resultText: string; toolCalls: ToolCall[] };

/** 写盘时给 historyAdapter 判协议用的元数据，与成功路径同一组字段。 */
export type TurnMeta = {
  backendType: BackendType;
  toolProtocol: ToolProtocol;
  modelId?: string;
  providerId?: string;
};

export type InterruptedTurn = {
  partial: PartialTurn;
  reason: InterruptReason;
  meta: TurnMeta;
};

/** 把中断信息挂到将要抛出的错误上——不动错误的 message/code，报错分类行为不变。 */
export function attachInterruptedTurn(err: Error, turn: InterruptedTurn): void {
  (err as Error & { interruptedTurn?: InterruptedTurn }).interruptedTurn = turn;
}

export function readInterruptedTurn(err: unknown): InterruptedTurn | null {
  if (err && typeof err === 'object' && 'interruptedTurn' in err) {
    return (err as { interruptedTurn?: InterruptedTurn }).interruptedTurn ?? null;
  }
  return null;
}

/**
 * 从中断信息构造要落盘的 incomplete assistant 消息。
 * 半截为空（一个 token 都没产出）→ 返回 null，不落盘（不留空壳）。
 */
export function buildInterruptedMessage(
  turn: InterruptedTurn,
  ids: { id: string; conversationId: string },
  now: number,
): ChatMessage | null {
  const { partial, reason, meta } = turn;
  const hasContent = partial.resultText.length > 0 || partial.toolCalls.length > 0;
  if (!hasContent) return null;
  return {
    id: ids.id,
    conversationId: ids.conversationId,
    role: 'assistant',
    text: partial.resultText,
    toolCalls: partial.toolCalls,
    createdAt: now,
    done: true,
    interrupted: reason,
    backendType: meta.backendType,
    toolProtocol: meta.toolProtocol,
    modelId: meta.modelId,
    providerId: meta.providerId,
  };
}
