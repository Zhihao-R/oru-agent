/**
 * G101（S11 · initiative.html#Deliver）在 S18 新执行路径下的承载对话解析：指定对话已归档/已删时，
 * resolveCarrierConversation 不翻出归档、新开一个对话承载（与渠道寻址「从不解档」同一口径）。
 * 归档判定随本期从旧 deliver dep 迁入执行体（executor.resolveCarrierConversation）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversation, ScheduledTask } from '@shared/types';

const { getConvMock, createSubMock, getOrCreateMock, listAgentsMock } = vi.hoisted(() => ({
  getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
  createSubMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['createSubConversation']>(),
  getOrCreateMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getOrCreateConversation']>(),
  listAgentsMock: vi.fn(),
}));
vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  getConversation: getConvMock,
  createSubConversation: createSubMock,
  getOrCreateConversation: getOrCreateMock,
  readHistoryForLLM: vi.fn(),
}));
vi.mock('../../electron/main/agent/store/agents', async (orig) => ({
  ...(await orig()),
  listAgents: listAgentsMock,
}));

import { resolveCarrierConversation } from '../../electron/main/scheduledTasks/executor';

const conv = (over: Partial<Conversation>): Conversation =>
  ({ id: 'c', ownerId: 'o', agentId: 'a', kind: 'sub', title: 't', sdkSessionId: null, createdAt: 0, updatedAt: 0, ...over }) as Conversation;

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask =>
  ({
    id: 't1', ownerId: 'o', agentId: 'a', title: '简报', prompt: 'x',
    runLocation: { kind: 'conversation', id: 'target' }, spec: { kind: 'daily', minutesOfDay: 480 },
    enabled: true, createdBy: 'user', nextRunAt: 0, runCount: 0, tz: 'UTC', pendingFires: [],
    createdAt: 0, updatedAt: 0, ...over,
  }) as ScheduledTask;

describe('executor.resolveCarrierConversation · 归档不被翻出（G101）', () => {
  beforeEach(() => {
    getConvMock.mockReset();
    createSubMock.mockReset();
    listAgentsMock.mockReset();
  });
  it('活跃指定对话（无 archivedAt）→ 用它承载', async () => {
    listAgentsMock.mockResolvedValue({ activeId: 'a' });
    getConvMock.mockResolvedValue(conv({ id: 'target' }));
    const r = await resolveCarrierConversation(task());
    expect(r.conversationId).toBe('target');
    expect(createSubMock).not.toHaveBeenCalled();
  });

  it('已归档指定对话 → 新开承载（不解档翻出）', async () => {
    listAgentsMock.mockResolvedValue({ activeId: 'a' });
    getConvMock.mockResolvedValue(conv({ id: 'target', archivedAt: Date.now() }));
    createSubMock.mockResolvedValue(conv({ id: 'fresh' }));
    const r = await resolveCarrierConversation(task());
    expect(r.conversationId).toBe('fresh');
    expect(createSubMock).toHaveBeenCalled();
  });

  it('已删指定对话（getConversation 抛）→ 降级新建', async () => {
    listAgentsMock.mockResolvedValue({ activeId: 'a' });
    getConvMock.mockRejectedValue(new Error('conversation not found'));
    createSubMock.mockResolvedValue(conv({ id: 'fresh2' }));
    const r = await resolveCarrierConversation(task());
    expect(r.conversationId).toBe('fresh2');
  });

  it('newConversation 落点 → 当场新建', async () => {
    listAgentsMock.mockResolvedValue({ activeId: 'a' });
    createSubMock.mockResolvedValue(conv({ id: 'brand-new' }));
    const r = await resolveCarrierConversation(task({ runLocation: { kind: 'newConversation' } }));
    expect(r.conversationId).toBe('brand-new');
    expect(getConvMock).not.toHaveBeenCalled();
  });
});

describe('executor.resolveCarrierConversation · 渠道落点（G42）', () => {
  beforeEach(() => {
    getConvMock.mockReset();
    createSubMock.mockReset();
    getOrCreateMock.mockReset();
    listAgentsMock.mockReset();
  });
  const channelTask = () => task({ runLocation: { kind: 'channel', platform: 'feishu', chatId: 'oc_1' } });

  // 渠道落点统一委托 getOrCreateConversation（内部：复用活跃绑定对话 / 归档或无则新建并绑定来源、不解档）——
  // 「每个渠道用户一个活跃对话、归档就新建」的语义收在该函数，此处只验执行体确实按平台＋聊天委托它、不裸建。
  it('委托 getOrCreateConversation 按平台＋聊天寻址，用它返回的承载', async () => {
    listAgentsMock.mockResolvedValue({ activeId: 'a' });
    getOrCreateMock.mockResolvedValue(conv({ id: 'bound', source: { platform: 'feishu', chatId: 'oc_1' } }));
    const r = await resolveCarrierConversation(channelTask());
    expect(r.conversationId).toBe('bound');
    expect(getOrCreateMock).toHaveBeenCalledWith('a', { platform: 'feishu', chatId: 'oc_1' }, expect.any(String));
    expect(createSubMock).not.toHaveBeenCalled(); // 不走裸建（那样新段不绑来源、成孤儿）
  });
});
