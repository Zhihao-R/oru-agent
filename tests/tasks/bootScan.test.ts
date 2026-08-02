/**
 * 崩溃恢复·启动扫描回归（S19·G18）——悬空（inflight）的派工任务判为 interrupted、返回供合成触发。
 * 已落终态的不动（幂等）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentTask } from '@shared/types';

const storeMock = vi.hoisted(() => ({
  all: [] as SubagentTask[],
  updates: [] as Array<{ id: string; status: SubagentTask['status'] }>,
}));

vi.mock('../../electron/main/tasks/store', () => ({
  listAllTasks: vi.fn(async () => storeMock.all),
  updateTaskStatus: vi.fn(async (id: string, status: SubagentTask['status']) => {
    storeMock.updates.push({ id, status });
    const base = storeMock.all.find((t) => t.id === id);
    return base ? { ...base, status } : null;
  }),
}));

import { scanDanglingTasksOnBoot } from '../../electron/main/tasks/bootScan';

function task(id: string, status: SubagentTask['status']): SubagentTask {
  return { id, status, conversationId: `c-${id}`, agentId: 'twin' } as unknown as SubagentTask;
}

beforeEach(() => {
  storeMock.all = [];
  storeMock.updates = [];
});

describe('scanDanglingTasksOnBoot（G18）', () => {
  it('inflight 任务判 interrupted、返回；终态任务不动', async () => {
    storeMock.all = [
      task('running1', 'running'),
      task('pending1', 'pending'),
      task('awaiting1', 'awaiting_user'),
      task('done1', 'done'),
      task('failed1', 'failed'),
    ];
    const recovered = await scanDanglingTasksOnBoot();
    const ids = recovered.map((t) => t.id).sort();
    expect(ids).toEqual(['awaiting1', 'pending1', 'running1']);
    expect(recovered.every((t) => t.status === 'interrupted')).toBe(true);
    // 终态任务没被 updateTaskStatus 碰过
    expect(storeMock.updates.map((u) => u.id)).not.toContain('done1');
    expect(storeMock.updates.map((u) => u.id)).not.toContain('failed1');
  });
});
