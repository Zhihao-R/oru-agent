import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
/**
 * enqueueTaskCompletionAnnounce（S09·G69）——后台任务完成走统一队列：
 * - 空闲：enqueueOrStart→started→起播报轮（nudge 作 userText，不落 user 气泡）。
 * - 正忙：→enqueued→trigger:'task-completed' 排队等回合末合并搭车（不起回合）。
 * - 无未播报任务 / 归档对话 → 不入队不起回合；已有排队 task-completed → 去重不重复入队。
 * 用真实 steeringQueue，mock 取数与 runChatAndPersist。
 */
const { getAgentMock, getConvMock, listTasksMock, getSettingsMock, runChatPersistMock } = vi.hoisted(
  () => ({
    getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
    getConvMock:
      vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
    listTasksMock:
      vi.fn<(typeof import('../../electron/main/tasks/store'))['listTasksForConversation']>(),
    getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
    runChatPersistMock:
      vi.fn<(typeof import('../../electron/main/ws/runChatAndPersist'))['runChatAndPersist']>(),
  }),
);
vi.mock('../../electron/main/agent/store/agents', async (orig) => ({
  ...(await orig()),
  getAgent: getAgentMock,
}));
vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  getConversation: getConvMock,
}));
vi.mock('../../electron/main/tasks/store', async (orig) => ({
  ...(await orig()),
  listTasksForConversation: listTasksMock,
}));
vi.mock('../../electron/main/projects/store', async (orig) => ({
  ...(await orig()),
  getSettings: getSettingsMock,
}));
vi.mock('../../electron/main/ws/runChatAndPersist', () => ({ runChatAndPersist: runChatPersistMock }));

import { enqueueTaskCompletionAnnounce } from '../../electron/main/ws/router';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';
import type { SubagentTask } from '@shared/types';

function doneTask(p?: Partial<SubagentTask>): SubagentTask {
  return { id: 't1', status: 'done', announcedAt: null, conversationId: 'c', ...p } as SubagentTask;
}

beforeEach(() => {
  vi.clearAllMocks();
  getAgentMock.mockResolvedValue({ id: 'a', ownerId: 'o' } as never);
  getConvMock.mockResolvedValue({ id: 'c', agentId: 'a', archivedAt: null } as never);
  listTasksMock.mockResolvedValue([doneTask()]);
  getSettingsMock.mockResolvedValue({ language: 'en' } as never);
  runChatPersistMock.mockResolvedValue('ok');
});

describe('enqueueTaskCompletionAnnounce', () => {
  it('空闲 + 有未播报 → 起一轮播报（nudge 作 userText，不落 user 气泡）', async () => {
    const conversationId = 'c-idle';
    getConvMock.mockResolvedValue({ id: conversationId, agentId: 'a', archivedAt: null } as never);
    await enqueueTaskCompletionAnnounce('a', conversationId, vi.fn());
    // 播报轮 fire-and-forget（void runAssembledMainTurn）——等它跑完
    await vi.waitFor(() => expect(runChatPersistMock).toHaveBeenCalledTimes(1));
    expect(runChatPersistMock.mock.calls[0][0].userText).toContain('System trigger');
    // 回合末 concludeTurn 排空 → 闸释放
    await vi.waitFor(() =>
      expect(steeringQueue.isRunning(steeringKey('a', conversationId))).toBe(false),
    );
  });

  it('正忙（闸已占）→ 入队 task-completed 排队、不起回合', async () => {
    const conversationId = 'c-busy';
    const key = steeringKey('a', conversationId);
    await steeringQueue.beginDirectTurn(key); // 模拟已有回合在跑
    await enqueueTaskCompletionAnnounce('a', conversationId, vi.fn());
    expect(runChatPersistMock).not.toHaveBeenCalled();
    expect(steeringQueue.hasQueuedTrigger(key, 'task-completed')).toBe(true);
    await steeringQueue.drainUnconsumedOnAbort(key); // 清理测试态
  });

  it('无未播报任务 → 不入队不起回合', async () => {
    listTasksMock.mockResolvedValue([doneTask({ announcedAt: 111 })]);
    const conversationId = 'c-none';
    await enqueueTaskCompletionAnnounce('a', conversationId, vi.fn());
    expect(runChatPersistMock).not.toHaveBeenCalled();
    expect(steeringQueue.isRunning(steeringKey('a', conversationId))).toBe(false);
  });

  it('归档对话 → 不唤醒', async () => {
    const conversationId = 'c-arch';
    getConvMock.mockResolvedValue({ id: conversationId, agentId: 'a', archivedAt: 123 } as never);
    await enqueueTaskCompletionAnnounce('a', conversationId, vi.fn());
    expect(runChatPersistMock).not.toHaveBeenCalled();
    expect(listTasksMock).not.toHaveBeenCalled(); // 归档即早退，不查任务
  });

  it('已有排队 task-completed → 去重不重复入队', async () => {
    const conversationId = 'c-dup';
    const key = steeringKey('a', conversationId);
    await steeringQueue.beginDirectTurn(key);
    await enqueueTaskCompletionAnnounce('a', conversationId, vi.fn()); // 第一条入队
    await enqueueTaskCompletionAnnounce('a', conversationId, vi.fn()); // 第二条应被去重
    expect(steeringQueue.pendingCount(key)).toBe(1);
    await steeringQueue.drainUnconsumedOnAbort(key);
  });
});
