/**
 * 渠道落点推送失败 → 承载对话留一条可见系统提示（不再只 console.warn 埋日志）。
 * 让用户知道"定时任务结果没发到远程渠道、只留在这条对话里"（如指向失效聊天 oc_stop、或网络失败）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, ScheduledTask } from '@shared/types';

const { deliverMock, appendMock } = vi.hoisted(() => ({
  deliverMock: vi.fn<(typeof import('../../electron/main/platform/outbound'))['deliverToChannel']>(),
  appendMock: vi.fn(async () => undefined),
}));
vi.mock('../../electron/main/platform/outbound', () => ({ deliverToChannel: deliverMock }));
vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  appendMessage: appendMock,
}));
// landResult 落盘后会推 conv.state 同步列表/通知（见 landResultConvState.test.ts）——
// 本测试不关心中介，挡掉避免 listConversations 读真实磁盘。
vi.mock('../../electron/main/ws/handlers/convState', () => ({ pushConvState: vi.fn(async () => undefined) }));
vi.mock('../../electron/main/projects/store', async (orig) => ({
  ...(await orig()),
  getSettings: vi.fn(async () => ({ language: 'zh' })),
}));

import { makeScheduledExecutorDeps } from '../../electron/main/scheduledTasks/executor';

const channelTask = (): ScheduledTask =>
  ({
    id: 't1', ownerId: 'o', agentId: 'a', title: '给我讲笑话', prompt: 'x',
    runLocation: { kind: 'channel', platform: 'feishu', chatId: 'oc_stop' },
    spec: { kind: 'interval', every: 5, unit: 'minute' },
    enabled: true, createdBy: 'user', nextRunAt: 0, runCount: 0, tz: 'UTC', createdAt: 0, updatedAt: 0,
  }) as ScheduledTask;

const land = async () =>
  makeScheduledExecutorDeps(() => {}).landResult({
    agentId: 'a',
    conversationId: 'c',
    task: channelTask(),
    result: { status: 'ok', text: '一个笑话' },
  });

const appendedTexts = (): string[] => appendMock.mock.calls.map((c) => (c[2] as ChatMessage).text);

describe('渠道推送失败 → 承载对话留可见提示', () => {
  beforeEach(() => {
    deliverMock.mockReset();
    appendMock.mockClear();
  });

  it('deliverToChannel 返回 !ok → 追加一条「没能推送到远程渠道」提示', async () => {
    deliverMock.mockResolvedValue({ ok: false, error: 'invalid chat_id oc_stop' });
    await land();
    expect(appendedTexts().some((t) => t.includes('没能推送到远程渠道'))).toBe(true);
  });

  it('deliverToChannel 抛错 → 同样追加提示（不静默）', async () => {
    deliverMock.mockRejectedValue(new Error('network down'));
    await land();
    expect(appendedTexts().some((t) => t.includes('没能推送到远程渠道'))).toBe(true);
  });

  it('deliverToChannel 成功 → 不追加失败提示', async () => {
    deliverMock.mockResolvedValue({ ok: true });
    await land();
    expect(appendedTexts().some((t) => t.includes('没能推送到远程渠道'))).toBe(false);
  });
});
