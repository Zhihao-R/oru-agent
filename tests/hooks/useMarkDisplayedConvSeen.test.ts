/** @vitest-environment jsdom */
/**
 * useMarkDisplayedConvSeen · 「停在对话里看着它完成 → 被误判待验收」回归（通知中心 §5.1 补缺）
 *
 * 老 bug：lastSeenAt 只在打开对话那一刻盖章，之后不动。人停在对话里、Oru 在眼前把活干完时，
 * 后端把 updatedAt 顶过水位 → deriveConvBadge 判 'unread' → 误进「已完成（待验收）」。
 * 修后：显示中对话的 updatedAt 一变，本 hook 就重新盖章，水位追上完成时刻。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { Conversation } from '@shared/types';

const ws = vi.hoisted(() => ({ calls: [] as ClientRequestPayload[] }));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> => {
      ws.calls.push(payload);
      return { type: 'ack' } as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useMarkDisplayedConvSeen } from '@/hooks/useMarkDisplayedConvSeen';
import { useConversationStore } from '@/stores/conversationStore';
import { deriveConvBadge } from '@/lib/conversationStatus';

const AGENT = 'a1';
const CONV = 'c1';

function conv(updatedAt: number, lastSeenAt?: number): Conversation {
  return {
    id: CONV,
    ownerId: 'local-user',
    agentId: AGENT,
    kind: 'sub',
    title: '看着它完成',
    sdkSessionId: null,
    createdAt: 1000,
    updatedAt,
    lastSeenAt,
  };
}

/** 从 store 读回当前 conv 的已读水位 */
function seenAt(): number | undefined {
  return useConversationStore.getState().byId[CONV]?.lastSeenAt;
}

/** 通知中心判定所需的 done 对话事实切片（无待办、未流式） */
function doneBadge(updatedAt: number, lastSeenAt?: number) {
  return deriveConvBadge({
    streaming: false,
    pendingProposals: 0,
    taskStatuses: [],
    lastMessageErrored: false,
    updatedAt,
    lastSeenAt,
  });
}

const markSeenCalls = () => ws.calls.filter((c) => c.type === 'conv.markSeen').length;
/** 盖章请求里点名了哪条对话（钉「只为传入的那条盖章」用） */
const markSeenCallsFor = (convId: string) =>
  ws.calls.filter((c) => c.type === 'conv.markSeen' && c.conversationId === convId).length;

beforeEach(() => {
  ws.calls = [];
  // 冻结时钟，显式推进——markSeen 内部用 Date.now() 盖章，不靠"恰好跨毫秒"造时间差（项目约定）
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('useMarkDisplayedConvSeen', () => {
  it('显示中对话完成（updatedAt 前进）时，水位追上 → 不再判为待验收', () => {
    // 打开那一刻：水位 = 当时 updatedAt，done 且已读 → 不进待验收
    const openedAt = Date.now();
    useConversationStore.setState({
      byAgent: { [AGENT]: [conv(openedAt, openedAt)] },
      byId: { [CONV]: conv(openedAt, openedAt) },
      activeByAgent: { [AGENT]: CONV },
    });
    expect(doneBadge(openedAt, openedAt)).toBe('none');

    const { rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useMarkDisplayedConvSeen(AGENT, CONV, updatedAt),
      { initialProps: { updatedAt: openedAt } },
    );
    expect(markSeenCalls()).toBe(1); // 挂载即盖一次章

    // Oru 在眼前把活干完：时间推进，后端刷新 updatedAt（同机时钟，> openedAt），syncForAgent 落进 store
    vi.advanceTimersByTime(5000);
    const completedAt = Date.now();
    useConversationStore.setState({
      byAgent: { [AGENT]: [conv(completedAt, openedAt)] },
      byId: { [CONV]: conv(completedAt, openedAt) },
    });
    // 没有本 hook 时：水位仍停在 openedAt < completedAt → 误判 'unread'（待验收）
    expect(doneBadge(completedAt, openedAt)).toBe('unread');

    // hook 接住 updatedAt 变化 → 重新盖章
    rerender({ updatedAt: completedAt });
    expect(markSeenCalls()).toBe(2);

    const advanced = seenAt();
    expect(advanced).toBeDefined();
    expect(advanced!).toBeGreaterThanOrEqual(completedAt); // 水位追上完成时刻
    expect(doneBadge(completedAt, advanced)).toBe('none'); // 不再待验收
  });

  it('updatedAt 不变的重渲染不重复盖章（不抖动）', () => {
    const t = Date.now();
    useConversationStore.setState({
      byAgent: { [AGENT]: [conv(t, t)] },
      byId: { [CONV]: conv(t, t) },
      activeByAgent: { [AGENT]: CONV },
    });
    const { rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useMarkDisplayedConvSeen(AGENT, CONV, updatedAt),
      { initialProps: { updatedAt: t } },
    );
    expect(markSeenCalls()).toBe(1);
    rerender({ updatedAt: t }); // 同一 updatedAt → effect 不重跑
    expect(markSeenCalls()).toBe(1);
  });

  it('草稿态（无 convId）不盖章', () => {
    renderHook(() => useMarkDisplayedConvSeen(AGENT, null, undefined));
    expect(markSeenCalls()).toBe(0);
  });

  // 两入口区分的承重不变量（cca1806 fix 的核心断言）：中断按停会顶高任意对话的 updatedAt，
  // 但本 hook 只为「传入的那条（= 显示中/active）」盖章。提醒中心按停的是**另一条没在看的**对话，
  // 它的 convId 永不传进本 hook → 水位不追平 → 保持 unread。这里钉住「非当前参数对话不被盖章」
  // 这个挂载条件，它守的是端到端不变量「提醒中心按停另一条对话仍显未读」。
  it('非当前参数对话（提醒中心按停的那条）不被盖章 → 水位不追平、仍判 unread', () => {
    const OTHER = 'c-other';
    const openedAt = Date.now();
    // 当前显示的是 CONV；另有一条没在看的 OTHER，水位停在打开时刻
    useConversationStore.setState({
      byAgent: { [AGENT]: [conv(openedAt, openedAt)] },
      byId: { [CONV]: conv(openedAt, openedAt) },
      activeByAgent: { [AGENT]: CONV },
    });
    // hook 只为 active 的 CONV 挂载（调用点 ChatArea 只传 activeConvId）
    renderHook(() => useMarkDisplayedConvSeen(AGENT, CONV, openedAt));
    expect(markSeenCallsFor(CONV)).toBe(1);

    // 提醒中心按停 OTHER：它半截落盘顶高自己的 updatedAt（越过其 lastSeenAt）
    vi.advanceTimersByTime(5000);
    const otherBumpedAt = Date.now();

    // 本 hook 从不为 OTHER 盖章 → 它的水位追不上 → 通知中心保持未读
    expect(markSeenCallsFor(OTHER)).toBe(0);
    expect(doneBadge(otherBumpedAt, openedAt)).toBe('unread');
  });
});
