/**
 * 终态主动播报（S09·G69 后）：taskAnnouncer 只剩「去抖 + 委派注入的 announce」——
 * 忙时放弃 / 30s 轮询 / announcing 互斥整套旧机制已退役（业务逻辑迁入 enqueueTaskCompletionAnnounce，
 * 见 tests/ws/enqueueTaskCompletionAnnounce.test.ts）。本文件只验去抖与委派。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { start, stop, notifyTaskTerminal, __announceForTest } from '../../electron/main/tasks/taskAnnouncer';

const announceMock = vi.fn<(agentId: string, conversationId: string) => Promise<void>>();
const DEBOUNCE_MS = 1_500;

beforeEach(() => {
  vi.useFakeTimers();
  announceMock.mockReset();
  announceMock.mockResolvedValue(undefined);
  start(announceMock);
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('taskAnnouncer', () => {
  it('task 终态去抖后调注入的 announce（带 agentId/conversationId）', async () => {
    notifyTaskTerminal('twin', 'c1');
    expect(announceMock).not.toHaveBeenCalled(); // 去抖窗内还没触发
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith('twin', 'c1');
  });

  it('去抖合并：同对话短时多次 notify 只触发一次', async () => {
    notifyTaskTerminal('twin', 'c1');
    await vi.advanceTimersByTimeAsync(500);
    notifyTaskTerminal('twin', 'c1'); // 窗口内再来 → 重置去抖
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(announceMock).toHaveBeenCalledTimes(1);
  });

  it('不同对话各自去抖、互不合并', async () => {
    notifyTaskTerminal('twin', 'c1');
    notifyTaskTerminal('twin', 'c2');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(announceMock).toHaveBeenCalledTimes(2);
  });

  it('stop 后 notify 不再触发（清空去抖计时器）', async () => {
    notifyTaskTerminal('twin', 'c1');
    stop();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it('未注入时 __announceForTest 安全早退', async () => {
    stop();
    await expect(__announceForTest('a', 'c')).resolves.toBeUndefined();
  });
});
