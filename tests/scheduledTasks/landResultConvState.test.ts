/**
 * 回归：定时任务执行体落结果后必须广播 conv.state（2026-07-30 修复）。
 *
 * 背景：通知中心 / 列表黄点 / 右上角角标全靠前端 conversationStore 的
 * 「updatedAt > lastSeenAt」判定，而 updatedAt 只随 conv.state 全量广播刷新。
 * landResult 此前只推 scheduledRun.finished（插卡片进 chatStore）+ scheduledTask.state
 * （刷定时任务页），从不推 conv.state——磁盘 updatedAt 已刷、前端浑然不知，
 * 任务页显示完成但右上角无通知；新建承载对话甚至长期不在对话列表里。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, Conversation, ScheduledTask } from '@shared/types';
import type { ServerEventPayload } from '@shared/protocol';

const { appendMock, listMock } = vi.hoisted(() => ({
  appendMock: vi.fn(async () => undefined),
  listMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['listConversations']>(),
}));
vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  appendMessage: appendMock,
  listConversations: listMock,
}));
vi.mock('../../electron/main/projects/store', async (orig) => ({
  ...(await orig()),
  getSettings: vi.fn(async () => ({ language: 'zh' })),
}));

import { makeScheduledExecutorDeps } from '../../electron/main/scheduledTasks/executor';

const convTask = (): ScheduledTask =>
  ({
    id: 't1', ownerId: 'o', agentId: 'a', title: '日报', prompt: 'x',
    runLocation: { kind: 'conversation', id: 'c' },
    spec: { kind: 'interval', every: 5, unit: 'minute' },
    enabled: true, createdBy: 'user', nextRunAt: 0, runCount: 0, tz: 'UTC', createdAt: 0, updatedAt: 0,
  }) as ScheduledTask;

/** 落盘后的对话索引：updatedAt 已顶过 lastSeenAt（appendMessage 刷的），未读事实成立 */
const landedConv = (): Conversation =>
  ({ id: 'c', updatedAt: 2000, lastSeenAt: 1000 }) as Conversation;

const land = async (broadcast: (ev: ServerEventPayload) => void, status: 'ok' | 'error') =>
  makeScheduledExecutorDeps(broadcast).landResult({
    agentId: 'a',
    conversationId: 'c',
    task: convTask(),
    result: status === 'ok' ? { status, text: '产出' } : { status, text: '', error: 'boom' },
  });

const convStateEvents = (events: ServerEventPayload[]) =>
  events.filter((e) => e.type === 'conv.state');

describe('landResult → conv.state 广播（通知链路回归）', () => {
  beforeEach(() => {
    appendMock.mockClear();
    listMock.mockReset();
    listMock.mockResolvedValue([landedConv()]);
  });

  it('成功落盘 → 广播 conv.state，且携带 updatedAt > lastSeenAt 的对话（未读可判）', async () => {
    const events: ServerEventPayload[] = [];
    await land((ev) => events.push(ev), 'ok');

    const pushes = convStateEvents(events);
    expect(pushes).toHaveLength(1);
    const convs = pushes[0].type === 'conv.state' ? pushes[0].conversations : [];
    const conv = convs.find((c) => c.id === 'c');
    expect(conv && conv.updatedAt > (conv.lastSeenAt ?? 0)).toBe(true);
    // 落盘在广播之前（广播的必须是刷过 updatedAt 的权威态）
    expect(appendMock).toHaveBeenCalled();
    expect(listMock).toHaveBeenCalledWith('a');
  });

  it('失败落盘 → 同样广播 conv.state（失败卡也是未读新动静）', async () => {
    const events: ServerEventPayload[] = [];
    await land((ev) => events.push(ev), 'error');
    expect(convStateEvents(events)).toHaveLength(1);
  });

  it('conv.state 先于 scheduledRun.finished 到达（卡片插入时列表已知该对话）', async () => {
    const order: string[] = [];
    await land((ev) => order.push(ev.type), 'ok');
    expect(order.indexOf('conv.state')).toBeLessThan(order.indexOf('scheduledRun.finished'));
  });
});
