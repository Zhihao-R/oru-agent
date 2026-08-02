/**
 * context-compressed 卡插到「被压缩内容之后」而非末尾（一期文档 §四）。
 * 压缩刚发生时卡若追加到末尾会贴着输入框、像输入区的一部分；应落在最后一条被压缩消息之后、
 * 保留的近几轮之前，随消息流滚走。
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/types';
import { insertContextCompressed } from '@/lib/contextCompressedInsert';

function msg(id: string, kind?: ChatMessage['kind']): ChatMessage {
  return {
    id,
    conversationId: 'c1',
    role: id.startsWith('u') ? 'user' : 'assistant',
    text: id,
    toolCalls: [],
    createdAt: 0,
    done: true,
    kind,
  };
}

function card(id: string, compressedMessageIds: string[]): ChatMessage {
  return {
    ...msg(id, 'context-compressed'),
    contextCompressed: {
      compressedMessageIds,
      summaryText: '摘要',
      summaryModelId: 'm',
      summaryProviderId: 'p',
      fallback: false,
    },
  };
}

describe('insertContextCompressed', () => {
  it('插到最后一条被压缩消息之后、保留内容之前', () => {
    // 列表：u1 a1（被压缩）| u2 a2（保留）
    const list = [msg('u1'), msg('a1'), msg('u2'), msg('a2')];
    const c = card('cc', ['u1', 'a1']);

    const next = insertContextCompressed(list, c);

    expect(next.map((m) => m.id)).toEqual(['u1', 'a1', 'cc', 'u2', 'a2']);
  });

  it('找不到被压缩消息（如 fallback 无 ids）：追加到末尾', () => {
    const list = [msg('u1'), msg('a1')];
    const c = card('cc', []);

    const next = insertContextCompressed(list, c);

    expect(next.map((m) => m.id)).toEqual(['u1', 'a1', 'cc']);
  });

  it('被压缩 id 不在当前列表：追加到末尾（保持原行为）', () => {
    const list = [msg('u2'), msg('a2')];
    const c = card('cc', ['u1', 'a1']); // 这些不在 list 里

    const next = insertContextCompressed(list, c);

    expect(next.map((m) => m.id)).toEqual(['u2', 'a2', 'cc']);
  });

  it('同 id 已存在：原样返回同一引用（防重复）', () => {
    const list = [msg('u1'), card('cc', ['u1'])];

    const next = insertContextCompressed(list, card('cc', ['u1']));

    expect(next).toBe(list);
  });

  it('取最后一条被压缩消息的位置（被压缩内容穿插时不插到中间）', () => {
    // 边界：被压缩 ids = u1,u2，但列表里 u1 a1 u2 a2，最后一条被压缩是 u2
    const list = [msg('u1'), msg('a1'), msg('u2'), msg('a2')];
    const c = card('cc', ['u1', 'u2']);

    const next = insertContextCompressed(list, c);

    expect(next.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'cc', 'a2']);
  });
});
