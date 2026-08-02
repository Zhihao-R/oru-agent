/**
 * 归档当前打开的对话 → 清空选中、落新建对话页（回归：activeId 豁免让已归档的当前对话
 * 继续留在活跃区且选中态不变，界面零变化，用户读作「点了没反应」）。
 * 并发护栏：archive 等待期间用户已切到别的对话 → 不清人家新开的选中。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { Conversation } from '@shared/types';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: requestMock as unknown as <T extends ServerEventPayload>(
      p: ClientRequestPayload,
    ) => Promise<T>,
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useConversationStore } from '@/stores/conversationStore';
import { useLandingNavStore } from '@/stores/landingNavStore';

const conv = (id: string, archivedAt?: number): Conversation =>
  ({ id, title: id, updatedAt: 1, ...(archivedAt ? { archivedAt } : {}) }) as Conversation;

beforeEach(() => {
  vi.stubGlobal('window', {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    } satisfies Partial<Storage>,
  });
  requestMock.mockReset();
  // markSeen 等 fire-and-forget 请求也走同一个 request：默认 reject（被调用方 .catch 吞）
  requestMock.mockRejectedValue(new Error('ws 未配置'));
  useConversationStore.setState({ byAgent: {}, activeByAgent: {}, byId: {}, archivedByAgent: {} });
  useLandingNavStore.setState({ line: 'chat', scrollRequest: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('archive 当前对话', () => {
  it('归档的正是当前打开的对话 → 清空选中并请求滚回顶部启动器', async () => {
    const s = useConversationStore.getState();
    s.syncForAgent('a1', [conv('c1')]);
    s.setActive('a1', 'c1');
    useLandingNavStore.setState({ scrollRequest: null });

    requestMock.mockResolvedValue({
      type: 'conv.state',
      agentId: 'a1',
      conversations: [conv('c1', 100)],
    });
    await useConversationStore.getState().archive('a1', 'c1');

    expect(useConversationStore.getState().activeByAgent['a1']).toBeUndefined();
    expect(useLandingNavStore.getState().scrollRequest).toBe('chat');
  });

  it('归档非当前对话 → 选中不动', async () => {
    const s = useConversationStore.getState();
    s.syncForAgent('a1', [conv('c1'), conv('c2')]);
    s.setActive('a1', 'c1');

    requestMock.mockResolvedValue({
      type: 'conv.state',
      agentId: 'a1',
      conversations: [conv('c1'), conv('c2', 100)],
    });
    await useConversationStore.getState().archive('a1', 'c2');

    expect(useConversationStore.getState().activeByAgent['a1']).toBe('c1');
  });

  it('并发：archive 等待期间用户切到 c2 → 不清人家新开的选中', async () => {
    const s = useConversationStore.getState();
    s.syncForAgent('a1', [conv('c1'), conv('c2')]);
    s.setActive('a1', 'c1');

    requestMock.mockImplementation(async () => {
      // 模拟等待期间用户点开了另一个对话
      useConversationStore.getState().setActive('a1', 'c2');
      return { type: 'conv.state', agentId: 'a1', conversations: [conv('c1', 100), conv('c2')] };
    });
    await useConversationStore.getState().archive('a1', 'c1');

    expect(useConversationStore.getState().activeByAgent['a1']).toBe('c2');
  });
});
