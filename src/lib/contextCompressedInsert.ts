import type { ChatMessage } from '@shared/types';

/**
 * 把 context-compressed 卡插到「被压缩内容之后」的位置——卡片语义是「这段早期内容已折叠为摘要」，
 * 应落在最后一条被压缩消息之后、保留的近几轮之前，随消息流一起滚走，而不是恒追加到末尾贴着输入框
 * （压缩刚发生时它本会成为最后一条消息，看起来像输入区的一部分）。一期文档 §四。
 *
 * - 同 id 已存在：原样返回（防重复）。
 * - 找不到任何被压缩消息（fallback 压缩无 ids、或这些消息不在当前显示列表里）：追加到末尾（保持原行为）。
 */
export function insertContextCompressed(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  if (list.some((m) => m.id === msg.id)) return list;
  const compressedIds = new Set(msg.contextCompressed?.compressedMessageIds ?? []);
  let insertAt = list.length;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (compressedIds.has(list[i].id)) {
      insertAt = i + 1;
      break;
    }
  }
  return [...list.slice(0, insertAt), msg, ...list.slice(insertAt)];
}
