/**
 * 对话分组 / 图标共享纯函数回归（对话列表与定时任务对话选择器共用一份，禁止各写一套）。
 */
import { describe, expect, it } from 'vitest';
import type { Conversation } from '@shared/types';
import { groupConversations, conversationIconKind } from '@/lib/conversationGrouping';

// 锚定 now = 2026-06-17（周三）15:00 本地
const NOW = new Date(2026, 5, 17, 15, 0, 0).getTime();

const conv = (over: Partial<Conversation> & { id: string }): Conversation =>
  ({
    ownerId: 'o',
    agentId: 'twin',
    kind: 'sub',
    title: 't',
    sdkSessionId: null,
    createdAt: 0,
    updatedAt: NOW,
    ...over,
  }) as Conversation;

describe('groupConversations', () => {
  it('按 updatedAt 分桶 today/week/earlier，归档单独成组', () => {
    const g = groupConversations(
      [
        conv({ id: 'a', updatedAt: new Date(2026, 5, 17, 9).getTime() }), // today
        conv({ id: 'b', updatedAt: new Date(2026, 5, 16, 9).getTime() }), // week
        conv({ id: 'c', updatedAt: new Date(2026, 5, 1, 9).getTime() }), // earlier
        conv({ id: 'd', archivedAt: NOW }), // archived
      ],
      { now: NOW },
    );
    expect(g.today.map((c) => c.id)).toEqual(['a']);
    expect(g.week.map((c) => c.id)).toEqual(['b']);
    expect(g.earlier.map((c) => c.id)).toEqual(['c']);
    expect(g.archived.map((c) => c.id)).toEqual(['d']);
  });

  it('正在看的对话即便已归档也留活跃区（前端兜底）', () => {
    const g = groupConversations(
      [conv({ id: 'x', archivedAt: NOW, updatedAt: new Date(2026, 5, 17, 9).getTime() })],
      { now: NOW, activeId: 'x' },
    );
    expect(g.today.map((c) => c.id)).toEqual(['x']);
    expect(g.archived).toEqual([]);
  });
});

describe('conversationIconKind', () => {
  it('随手评点=aside / 平台来源=platform / 否则=normal', () => {
    expect(conversationIconKind(conv({ id: '1', kind: 'aside' }))).toBe('aside');
    expect(
      conversationIconKind(conv({ id: '2', source: { platform: 'feishu', chatId: 'c' } })),
    ).toBe('platform');
    expect(conversationIconKind(conv({ id: '3' }))).toBe('normal');
  });
});

// 原 pinTodos（G108 待办浮顶）测试随该功能于 2026-07-19 骨-3 拍板取消一并删除。
