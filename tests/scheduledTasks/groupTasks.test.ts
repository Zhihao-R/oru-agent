/**
 * groupTasks() 聚合唯一入口回归
 *
 * 多触发规则聚合层：多条共享 groupId 的底层 task → 一个 TaskGroup。纯函数、无 store，
 * 逐条字段的合并口径（enabled/nextRunAt/missedAt/lastRun/runHistory）在此钉死。
 */
import { describe, expect, it } from 'vitest';
import type { ScheduledTask } from '@shared/types';
import { groupTasks } from '../../electron/main/scheduledTasks/groupTasks';

function task(id: string, over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    groupId: id,
    ownerId: 'o',
    agentId: 'twin',
    title: '每日简报',
    prompt: '汇总昨天的笔记',
    runLocation: { kind: 'newConversation' },
    spec: { kind: 'daily', minutesOfDay: 8 * 60 },
    enabled: true,
    createdBy: 'user',
    nextRunAt: 1000,
    runCount: 0,
    tz: 'UTC',
    pendingFires: [],
    runHistory: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('scheduledTasks/groupTasks', () => {
  it('两条同 groupId + 一条独立 → 2 个 group；多规则组 rules.length=2、nextRunAt 取较近', () => {
    const tasks = [
      task('a1', { groupId: 'g1', createdAt: 10, nextRunAt: 5000 }),
      task('a2', { groupId: 'g1', createdAt: 20, nextRunAt: 3000 }),
      task('b1', { groupId: 'b1', createdAt: 30, nextRunAt: 8000 }),
    ];
    const groups = groupTasks(tasks);
    expect(groups.length).toBe(2);
    const g1 = groups.find((g) => g.groupId === 'g1')!;
    expect(g1.rules.length).toBe(2);
    expect(g1.nextRunAt).toBe(3000); // 两条活跃里较近的
  });

  it('组主取 createdAt 最早那条的 title/prompt/runLocation/createdBy', () => {
    const tasks = [
      task('a2', { groupId: 'g1', createdAt: 20, title: '晚', createdBy: 'agent' }),
      task('a1', { groupId: 'g1', createdAt: 10, title: '早', createdBy: 'user' }),
    ];
    const [g] = groupTasks(tasks);
    expect(g.title).toBe('早');
    expect(g.createdBy).toBe('user');
    expect(g.createdAt).toBe(10);
  });

  it('enabled = 组内 some；nextRunAt 只看活跃规则、全 null → null', () => {
    const g = groupTasks([
      task('a1', { groupId: 'g1', enabled: false, nextRunAt: null }),
      task('a2', { groupId: 'g1', enabled: true, nextRunAt: 2000 }),
    ])[0];
    expect(g.enabled).toBe(true);
    expect(g.nextRunAt).toBe(2000);

    const dead = groupTasks([
      task('x1', { groupId: 'g2', enabled: false, nextRunAt: null }),
      task('x2', { groupId: 'g2', enabled: false, nextRunAt: null }),
    ])[0];
    expect(dead.enabled).toBe(false);
    expect(dead.nextRunAt).toBe(null);
  });

  it('missedAt 取组内 max；lastRun 取 at 最大那条；runHistory 组内合并按 at 降序', () => {
    const g = groupTasks([
      task('a1', {
        groupId: 'g1',
        missedAt: 100,
        lastRun: { at: 50, status: 'ok', late: false },
        runHistory: [{ at: 50, status: 'ok', late: false }],
      }),
      task('a2', {
        groupId: 'g1',
        missedAt: 300,
        lastRun: { at: 90, status: 'error', late: false },
        runHistory: [{ at: 90, status: 'error', late: false }],
      }),
    ])[0];
    expect(g.missedAt).toBe(300);
    expect(g.lastRun?.at).toBe(90);
    expect(g.runHistory.map((r) => r.at)).toEqual([90, 50]);
  });

  it('单条任务 → 单规则组，字段与原 task 一一对应（回归护栏）', () => {
    const t = task('solo', {
      groupId: 'solo',
      nextRunAt: 4242,
      missedAt: 7,
      lastRun: { at: 3, status: 'ok', late: true },
      stopAfterRuns: 5,
    });
    const [g] = groupTasks([t]);
    expect(g.groupId).toBe('solo');
    expect(g.rules).toEqual([
      { taskId: 'solo', spec: t.spec, stopAfterRuns: 5, nextRunAt: 4242, enabled: true, missedAt: 7 },
    ]);
    expect(g.nextRunAt).toBe(4242);
    expect(g.missedAt).toBe(7);
    expect(g.lastRun).toEqual(t.lastRun);
    expect(g.title).toBe(t.title);
  });

  it('组间按 nextRunAt 近的靠前、活跃优先（全终结的组排后）', () => {
    const groups = groupTasks([
      task('a', { groupId: 'ga', nextRunAt: 9000 }),
      task('b', { groupId: 'gb', nextRunAt: null, enabled: false }),
      task('c', { groupId: 'gc', nextRunAt: 1000 }),
    ]);
    expect(groups.map((g) => g.groupId)).toEqual(['gc', 'ga', 'gb']);
  });
});
