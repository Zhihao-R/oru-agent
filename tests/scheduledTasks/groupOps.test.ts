/**
 * groupOps 组写原语回归（多触发规则）
 *
 * 组写唯一入口：建/改/删/停一个「用户任务」= 对组内多条底层 task 的批量操作。
 * 承重断言：
 *  ① update 改 spec 才触发 nextRunAt 重算、只改标题不重排程；
 *  ② 删组内中间一条规则、其余按 taskId 对齐——剩余条的 runCount/nextRunAt 不被错配（C1 回归）；
 *  ③ 未改 spec 的条 update 时不写 nextRunAt（不覆盖并发 fire 推进的游标）（C2 回归）；
 *  ④ setEnabled 组内全翻；
 *  ⑤ interval 规则强制次数（Task 1.3）。
 *
 * store 用有状态内存 mock（才能验 taskId 对齐 diff）；scheduler 便捷入口 mock 掉（不启真调度）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledTask, TaskGroupInput } from '@shared/types';

const db = new Map<string, ScheduledTask>();
const store = {
  listScheduledTasks: vi.fn(async () => [...db.values()]),
  getScheduledTask: vi.fn(async (id: string) => db.get(id) ?? null),
  createScheduledTask: vi.fn(async (t: ScheduledTask) => {
    db.set(t.id, t);
  }),
  patchScheduledTask: vi.fn(async (id: string, patch: Partial<ScheduledTask>) => {
    const cur = db.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id, updatedAt: Date.now() } as ScheduledTask;
    db.set(id, next);
    return next;
  }),
  deleteScheduledTask: vi.fn(async (id: string) => {
    db.delete(id);
  }),
};
vi.mock('../../electron/main/scheduledTasks/store', () => store);
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'owner-1',
}));
const sched = {
  runScheduledTaskNow: vi.fn(async () => ({ alreadyRunning: false })),
  dismissScheduledMissed: vi.fn(async () => undefined),
};
vi.mock('../../electron/main/scheduledTasks/scheduler', () => sched);

const META = { ownerId: 'owner-1', agentId: 'twin', createdBy: 'user' as const };

function inGroup(groupId: string): ScheduledTask[] {
  return [...db.values()].filter((t) => t.groupId === groupId).sort((a, b) => a.createdAt - b.createdAt);
}

beforeEach(() => {
  db.clear();
  vi.clearAllMocks();
});

describe('deriveTaskTitle helper（空白 / 超长截断）', () => {
  it('空白/缺省 title → prompt trim 后前 20 字；超长截断；非空 title trim 原样', async () => {
    const { deriveTaskTitle } = await import('../../shared/scheduledTasks/deriveTitle');
    expect(deriveTaskTitle('  ', '  一二三四五六七八九十1234567890ABC  ')).toBe('一二三四五六七八九十1234567890');
    expect(deriveTaskTitle(undefined, '短')).toBe('短');
    expect(deriveTaskTitle(' 名字 ', 'prompt')).toBe('名字');
  });
});

describe('groupOps · 建/改/删', () => {
  it('createTaskGroup：title 留空 → 落盘 prompt 前 20 字（打磨 6b 自动命名）；非空 → 原样', async () => {
    const { createTaskGroup } = await import('../../electron/main/scheduledTasks/groupOps');
    const blank = await createTaskGroup(
      {
        title: '   ',
        prompt: '  提醒我每周一早上把周报发给老板并抄送全组同学  ',
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'daily', minutesOfDay: 480 } }],
      },
      META,
    );
    // 空白 title → 派生（prompt trim 后前 20 字）
    expect(inGroup(blank)[0].title).toBe('提醒我每周一早上把周报发给老板并抄送全组同学'.slice(0, 20));

    const named = await createTaskGroup(
      {
        title: '晨间',
        prompt: '汇总',
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'daily', minutesOfDay: 480 } }],
      },
      META,
    );
    expect(inGroup(named)[0].title).toBe('晨间'); // 非空原样（trim 后）
  });

  it('updateTaskGroup：编辑时清空 title → 重新自动命名（清空=留空）', async () => {
    const { createTaskGroup, updateTaskGroup } = await import(
      '../../electron/main/scheduledTasks/groupOps'
    );
    const groupId = await createTaskGroup(
      {
        title: '晨间',
        prompt: '汇总今日要闻',
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'daily', minutesOfDay: 480 } }],
      },
      META,
    );
    const taskId = inGroup(groupId)[0].id;
    await updateTaskGroup(groupId, {
      title: '',
      prompt: '汇总今日要闻',
      runLocation: { kind: 'newConversation' },
      rules: [{ taskId, spec: { kind: 'daily', minutesOfDay: 480 } }],
    });
    expect(inGroup(groupId)[0].title).toBe('汇总今日要闻');
  });

  it('createTaskGroup 建 2 规则 → 2 条同 groupId', async () => {
    const { createTaskGroup } = await import('../../electron/main/scheduledTasks/groupOps');
    const input: TaskGroupInput = {
      title: '晨间',
      prompt: '汇总',
      runLocation: { kind: 'newConversation' },
      rules: [
        { spec: { kind: 'daily', minutesOfDay: 480 } },
        { spec: { kind: 'weekly', weekdays: [1], minutesOfDay: 840 } },
      ],
    };
    const groupId = await createTaskGroup(input, META);
    const tasks = inGroup(groupId);
    expect(tasks.length).toBe(2);
    expect(tasks.every((t) => t.groupId === groupId)).toBe(true);
    expect(tasks[0].nextRunAt).not.toBeNull(); // 建时算了游标
  });

  it('updateTaskGroup 减到 1 规则 → 剩 1 条；deleteTaskGroup → 0 条', async () => {
    const { createTaskGroup, updateTaskGroup, deleteTaskGroup } = await import(
      '../../electron/main/scheduledTasks/groupOps'
    );
    const groupId = await createTaskGroup(
      {
        title: 't',
        prompt: 'p',
        runLocation: { kind: 'newConversation' },
        rules: [
          { spec: { kind: 'daily', minutesOfDay: 480 } },
          { spec: { kind: 'weekly', weekdays: [1], minutesOfDay: 840 } },
        ],
      },
      META,
    );
    const [a, b] = inGroup(groupId);
    await updateTaskGroup(groupId, {
      title: 't',
      prompt: 'p',
      runLocation: { kind: 'newConversation' },
      rules: [{ taskId: b.id, spec: b.spec }],
    });
    expect(inGroup(groupId).map((t) => t.id)).toEqual([b.id]);
    expect(db.has(a.id)).toBe(false);
    await deleteTaskGroup(groupId);
    expect(inGroup(groupId).length).toBe(0);
  });

  it('① 改 spec 才重算 nextRunAt；只改标题不重排程', async () => {
    const { createTaskGroup, updateTaskGroup } = await import(
      '../../electron/main/scheduledTasks/groupOps'
    );
    const groupId = await createTaskGroup(
      {
        title: 't',
        prompt: 'p',
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'daily', minutesOfDay: 480 } }],
      },
      META,
    );
    const [only] = inGroup(groupId);
    const before = only.nextRunAt;
    // 只改标题：nextRunAt 不动
    await updateTaskGroup(groupId, {
      title: '新标题',
      prompt: 'p',
      runLocation: { kind: 'newConversation' },
      rules: [{ taskId: only.id, spec: only.spec }],
    });
    expect(inGroup(groupId)[0].nextRunAt).toBe(before);
    expect(inGroup(groupId)[0].title).toBe('新标题');
    // 改 spec（时刻不同）：nextRunAt 重算
    await updateTaskGroup(groupId, {
      title: '新标题',
      prompt: 'p',
      runLocation: { kind: 'newConversation' },
      rules: [{ taskId: only.id, spec: { kind: 'daily', minutesOfDay: 1200 } }],
    });
    expect(inGroup(groupId)[0].nextRunAt).not.toBe(before);
  });

  it('② 删中间一条规则、其余按 taskId 对齐——runCount/nextRunAt 不被错配（C1）', async () => {
    const { createTaskGroup, updateTaskGroup } = await import(
      '../../electron/main/scheduledTasks/groupOps'
    );
    const groupId = await createTaskGroup(
      {
        title: 't',
        prompt: 'p',
        runLocation: { kind: 'newConversation' },
        rules: [
          { spec: { kind: 'daily', minutesOfDay: 480 } }, // A
          { spec: { kind: 'daily', minutesOfDay: 720 } }, // B
          { spec: { kind: 'weekly', weekdays: [1], minutesOfDay: 840 } }, // C
        ],
      },
      META,
    );
    const [a, b, c] = inGroup(groupId);
    // B、C 各自累了历史与游标
    db.set(b.id, { ...db.get(b.id)!, runCount: 9, nextRunAt: 8888 });
    db.set(c.id, { ...db.get(c.id)!, runCount: 3, nextRunAt: 7777 });
    // 删中间的 B，保留 A、C（spec 不变，按 taskId 对齐）
    await updateTaskGroup(groupId, {
      title: 't',
      prompt: 'p',
      runLocation: { kind: 'newConversation' },
      rules: [
        { taskId: a.id, spec: a.spec },
        { taskId: c.id, spec: c.spec },
      ],
    });
    expect(db.has(b.id)).toBe(false);
    // C 的历史与游标没被 B 的嫁接（下标 diff 会把 C 当成 B 的位置）
    expect(db.get(c.id)!.runCount).toBe(3);
    expect(db.get(c.id)!.nextRunAt).toBe(7777);
  });

  it('③ 未改 spec 的条 update 时不写 nextRunAt（不覆盖并发 fire 游标）（C2）', async () => {
    const { createTaskGroup, updateTaskGroup } = await import(
      '../../electron/main/scheduledTasks/groupOps'
    );
    const groupId = await createTaskGroup(
      {
        title: 't',
        prompt: 'p',
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'daily', minutesOfDay: 480 } }],
      },
      META,
    );
    const [only] = inGroup(groupId);
    store.patchScheduledTask.mockClear();
    await updateTaskGroup(groupId, {
      title: '改标题',
      prompt: 'p',
      runLocation: { kind: 'newConversation' },
      rules: [{ taskId: only.id, spec: only.spec }],
    });
    const patchArg = store.patchScheduledTask.mock.calls[0][1] as Partial<ScheduledTask>;
    expect('nextRunAt' in patchArg).toBe(false);
  });

  it('④ setTaskGroupEnabled 组内全翻', async () => {
    const { createTaskGroup, setTaskGroupEnabled } = await import(
      '../../electron/main/scheduledTasks/groupOps'
    );
    const groupId = await createTaskGroup(
      {
        title: 't',
        prompt: 'p',
        runLocation: { kind: 'newConversation' },
        rules: [
          { spec: { kind: 'daily', minutesOfDay: 480 } },
          { spec: { kind: 'weekly', weekdays: [1], minutesOfDay: 840 } },
        ],
      },
      META,
    );
    await setTaskGroupEnabled(groupId, false);
    expect(inGroup(groupId).every((t) => t.enabled === false)).toBe(true);
    await setTaskGroupEnabled(groupId, true);
    expect(inGroup(groupId).every((t) => t.enabled === true)).toBe(true);
  });
});

describe('groupOps · 错过区组级动作', () => {
  it('runGroupMissed 只对 missedAt!=null 的条补跑；dismissGroupMissed 对每条忽略', async () => {
    const { createTaskGroup, runGroupMissed, dismissGroupMissed } = await import(
      '../../electron/main/scheduledTasks/groupOps'
    );
    const groupId = await createTaskGroup(
      {
        title: 't',
        prompt: 'p',
        runLocation: { kind: 'newConversation' },
        rules: [
          { spec: { kind: 'daily', minutesOfDay: 480 } },
          { spec: { kind: 'daily', minutesOfDay: 720 } },
        ],
      },
      META,
    );
    const [a, b] = inGroup(groupId);
    db.set(a.id, { ...db.get(a.id)!, missedAt: 123 }); // 只有 a 错过
    await runGroupMissed(groupId);
    expect(sched.runScheduledTaskNow).toHaveBeenCalledTimes(1);
    expect(sched.runScheduledTaskNow).toHaveBeenCalledWith(a.id);
    await dismissGroupMissed(groupId);
    expect(sched.dismissScheduledMissed).toHaveBeenCalledTimes(1);
    expect(sched.dismissScheduledMissed).toHaveBeenCalledWith(a.id);
    expect(b.id).toBeTruthy(); // b 未错过，两动作都不碰
  });
});

describe('groupOps · interval 强制次数（Task 1.3）', () => {
  it('createTaskGroup 传 interval 但缺 stopAfterRuns → throw', async () => {
    const { createTaskGroup } = await import('../../electron/main/scheduledTasks/groupOps');
    await expect(
      createTaskGroup(
        {
          title: 't',
          prompt: 'p',
          runLocation: { kind: 'newConversation' },
          rules: [{ spec: { kind: 'interval', every: 5, unit: 'minute' } }],
        },
        META,
      ),
    ).rejects.toThrow(/次数/);
    expect(store.createScheduledTask).not.toHaveBeenCalled();
  });

  it('createTaskGroup 传过去时刻的一次性 → throw，且不落 store（未来时刻闸·review M4）', async () => {
    const { createTaskGroup } = await import('../../electron/main/scheduledTasks/groupOps');
    const PAST = new Date(2020, 0, 1, 9, 0, 0).getTime();
    await expect(
      createTaskGroup(
        {
          title: 't',
          prompt: 'p',
          runLocation: { kind: 'newConversation' },
          rules: [{ spec: { kind: 'once', at: PAST } }],
        },
        META,
      ),
    ).rejects.toThrow();
    expect(store.createScheduledTask).not.toHaveBeenCalled();
  });

  it('createTaskGroup interval 带 stopAfterRuns → 正常', async () => {
    const { createTaskGroup } = await import('../../electron/main/scheduledTasks/groupOps');
    const groupId = await createTaskGroup(
      {
        title: 't',
        prompt: 'p',
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'interval', every: 5, unit: 'minute' }, stopAfterRuns: 3 }],
      },
      META,
    );
    expect(inGroup(groupId)[0].stopAfterRuns).toBe(3);
  });
});

describe('groupOps · update 语义不含 create（审批窗内组被删回归）', () => {
  it('updateTaskGroup 对不存在的组 throw，不静默重建', async () => {
    const { updateTaskGroup } = await import('../../electron/main/scheduledTasks/groupOps');
    await expect(
      updateTaskGroup('ghost', {
        title: 't',
        prompt: 'p',
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'daily', minutesOfDay: 480 } }],
      }),
    ).rejects.toThrow(/不存在/);
    expect(store.createScheduledTask).not.toHaveBeenCalled();
  });
});
