/**
 * 定时任务调度器编排回归（S18 后台执行路径）——注入可控时钟 + 内存 store + spawn spy。
 *
 * 调度段（本模块）只负责：时区锚核对（G100）、到点宽限窗判定（G99）、到点一次落盘「推进游标 ＋
 * 记投递账」（G41）后 fire-and-forget 交 spawn（G98）。结算（计次/销账/lastRun）单点在执行体（G43），
 * 故本测不再验 lastRun——那些移到 executor 测。这里验：
 * - await 后重检：tick 挑出 due 后、fire 前任务被改（暂停/改时刻）→ 不 spawn、不落账
 * - 占位防重复：fire 先 recordFire 推进 nextRunAt + 记一笔账，下一轮 tick 不再触发同一 due
 * - 宽限窗：落后在窗内到点触发、超窗按错过（不当场补跑，missedAt）
 * - 时区锚：进程时区变 → daily 重算 nextRunAt、once 只换锚
 * - tick inflight 护栏；一次性 / stopAfterRuns 终态
 * - reconcile：离线漏跑标 missedAt（每任务一条）+ 残留账收编；宽限内留给首 tick
 * - runTaskNow 走 spawn(manual)；dismissMissed 只清不跑
 */
import { describe, it, expect, vi } from 'vitest';
import type { PendingFire, ScheduledTask } from '@shared/types';
import {
  fireDueTask,
  runDueTasks,
  runTaskNow,
  dismissMissed,
  reconcileOnBoot,
  tickOnce,
  GRACE_MS,
  type SchedulerDeps,
} from '../../electron/main/scheduledTasks/scheduler';
import { currentTimeZone } from '../../electron/main/scheduledTasks/schedule';

const T = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo, d, h, mi, 0, 0).getTime();
const DAY8 = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 'a',
  ownerId: 'o',
  agentId: 'twin',
  title: '每日简报',
  prompt: '汇总昨天的笔记',
  runLocation: { kind: 'newConversation' },
  spec: { kind: 'daily', minutesOfDay: 8 * 60 },
  enabled: true,
  createdBy: 'user',
  nextRunAt: T(2026, 5, 23, 8, 0),
  runCount: 0,
  tz: currentTimeZone(),
  pendingFires: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/** 内存 store + spawn spy，类型锚到真实 SchedulerDeps（接口变形即红，不裸对象蒙混）。 */
function makeDeps(seed: ScheduledTask[], nowMs = T(2026, 5, 23, 8, 0) + 1000) {
  const map = new Map(seed.map((t) => [t.id, structuredClone(t)]));
  const spawn = vi.fn((_id: string, _o: { manual?: boolean; late?: boolean }) => ({ alreadyRunning: false }));
  let now = nowMs;
  const deps: SchedulerDeps = {
    now: () => now,
    list: async () => [...map.values()].map((t) => structuredClone(t)),
    get: async (id) => (map.has(id) ? structuredClone(map.get(id)!) : null),
    patch: async (id, patch) => {
      const cur = map.get(id);
      if (!cur) return null;
      const next = { ...cur, ...patch, id: cur.id } as ScheduledTask;
      map.set(id, next);
      return structuredClone(next);
    },
    recordFire: async (id, fire: PendingFire, computeAdvance) => {
      const cur = map.get(id);
      if (!cur) return null;
      const advance = computeAdvance(structuredClone(cur)); // 锁内基于最新 cur 算
      const next: ScheduledTask = {
        ...cur,
        nextRunAt: advance.nextRunAt,
        enabled: advance.enabled,
        pendingFires: [...(cur.pendingFires ?? []), fire],
      };
      map.set(id, next);
      return structuredClone(next);
    },
    reconcileFires: async (id) => {
      const cur = map.get(id);
      if (!cur) return null;
      const fires = cur.pendingFires ?? [];
      if (fires.length === 0) return null;
      const stillValid = cur.enabled && (cur.stopAfterRuns == null || cur.runCount < cur.stopAfterRuns);
      const latestDue = Math.max(...fires.map((f) => f.dueAt));
      const next: ScheduledTask = {
        ...cur,
        pendingFires: [],
        ...(stillValid ? { missedAt: latestDue } : {}),
      };
      map.set(id, next);
      return structuredClone(next);
    },
    spawn,
  };
  return { deps, map, spawn, setNow: (v: number) => (now = v) };
}

describe('scheduler · await 后重检', () => {
  it('fire 前任务被暂停 → 不 spawn、不落账', async () => {
    const { deps, map, spawn } = makeDeps([DAY8()]);
    map.set('a', { ...map.get('a')!, enabled: false });
    await fireDueTask(deps, 'a', T(2026, 5, 23, 8, 0));
    expect(spawn).not.toHaveBeenCalled();
    expect(map.get('a')!.pendingFires).toEqual([]);
  });

  it('fire 前 nextRunAt 被改（时刻调整）→ 不 spawn', async () => {
    const { deps, map, spawn } = makeDeps([DAY8()]);
    map.set('a', { ...map.get('a')!, nextRunAt: T(2026, 5, 25, 8, 0) });
    await fireDueTask(deps, 'a', T(2026, 5, 23, 8, 0));
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('scheduler · 占位防重复 + 记账', () => {
  it('fire 先 recordFire 推进 nextRunAt + 记一笔账，下一轮不再触发同一 due', async () => {
    const due = T(2026, 5, 23, 8, 0);
    const { deps, spawn, map } = makeDeps([DAY8()], due + 1000);
    await runDueTasks(deps);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('a', { manual: false, late: false });
    const t = map.get('a')!;
    expect(t.nextRunAt).toBe(T(2026, 5, 24, 8, 0)); // 已推进到次日
    expect(t.pendingFires).toEqual([{ dueAt: due, firedAt: due + 1000 }]); // 记了一笔账
    await runDueTasks(deps);
    expect(spawn).toHaveBeenCalledTimes(1); // 不重复
  });
});

describe('scheduler · 宽限窗（G99）', () => {
  it('落后恰好在宽限窗边界内 → 到点触发', async () => {
    const due = T(2026, 5, 23, 8, 0);
    const { deps, spawn } = makeDeps([DAY8()], due + GRACE_MS);
    await runDueTasks(deps);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('落后超过宽限窗 → 按错过（missedAt）、不 spawn、推进 future', async () => {
    const due = T(2026, 5, 23, 8, 0);
    const { deps, spawn, map } = makeDeps([DAY8()], due + GRACE_MS + 1);
    await runDueTasks(deps);
    expect(spawn).not.toHaveBeenCalled();
    const t = map.get('a')!;
    expect(t.missedAt).toBe(T(2026, 5, 23, 8, 0)); // 坍缩成最近一次
    expect(t.nextRunAt).toBe(T(2026, 5, 24, 8, 0)); // 推进 future
    expect(t.pendingFires).toEqual([]); // 错过不落账
  });

  it('休眠唤醒后积压跨多日 → 只标最近一次错过、不逐个补跑', async () => {
    const { deps, spawn, map } = makeDeps([DAY8({ nextRunAt: T(2026, 5, 20, 8, 0) })], T(2026, 5, 25, 12, 0));
    await runDueTasks(deps);
    expect(spawn).not.toHaveBeenCalled();
    expect(map.get('a')!.missedAt).toBe(T(2026, 5, 25, 8, 0));
  });
});

describe('scheduler · 时区锚（G100）', () => {
  it('进程时区与锚不符：daily 重算 nextRunAt + 换锚（不 spawn，游标仍未来）', async () => {
    // 锚设成一个必不等于本机的假时区，nextRunAt 设在明显未来避免触发
    const future = T(2026, 6, 1, 8, 0);
    const { deps, map } = makeDeps([DAY8({ tz: 'Fake/Zone', nextRunAt: future })], T(2026, 5, 23, 12, 0));
    await runDueTasks(deps);
    const t = map.get('a')!;
    expect(t.tz).toBe(currentTimeZone()); // 锚更新为进程当前时区
    // daily 是挂钟相对：nextRunAt 被按当前时区重算（本机时区下 8:00 的下一个未来点）
    expect(t.nextRunAt).not.toBeNull();
  });

  it('进程时区与锚不符：once 只换锚、不动绝对时刻', async () => {
    const at = T(2026, 6, 1, 10, 0);
    const { deps, map } = makeDeps(
      [DAY8({ spec: { kind: 'once', at }, tz: 'Fake/Zone', nextRunAt: at })],
      T(2026, 5, 23, 12, 0),
    );
    await runDueTasks(deps);
    const t = map.get('a')!;
    expect(t.tz).toBe(currentTimeZone());
    expect(t.nextRunAt).toBe(at); // once 绝对时刻不重算
  });
});

describe('scheduler · tick inflight 护栏', () => {
  it('未结束时再次进入直接 return，不并发扫两轮', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, spawn } = makeDeps([DAY8()]);
    const slow: SchedulerDeps = { ...deps, list: async () => (await gate, deps.list()) };
    const first = tickOnce(slow);
    const second = tickOnce(slow);
    await second;
    expect(spawn).not.toHaveBeenCalled();
    release();
    await first;
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('scheduler · 终态', () => {
  it('一次性触发后 nextRunAt=null', async () => {
    const at = T(2026, 5, 23, 10, 0);
    const { deps, map } = makeDeps([DAY8({ spec: { kind: 'once', at }, nextRunAt: at })], at + 1000);
    await runDueTasks(deps);
    expect(map.get('a')!.nextRunAt).toBeNull();
  });

  it('stopAfterRuns=3：连跑到配额后停用、nextRunAt=null（fire 推进游标、停用收敛 settle）', async () => {
    const { deps, map, setNow } = makeDeps([DAY8({ stopAfterRuns: 3, runCount: 0 })], T(2026, 5, 23, 8, 0) + 1000);
    // fire（recordFire·deferDisable）只推进游标、不计次也不当场停用；计次与终态停用都在执行体 settleRun。
    // 本测内存 store 不接执行体，手动模拟 settle：runCount+1，到顶（>=stopAfterRuns）连带翻 enabled。
    const settle = () => {
      const c = map.get('a')!;
      const runCount = c.runCount + 1;
      map.set('a', { ...c, runCount, enabled: runCount >= 3 ? false : c.enabled });
    };
    await runDueTasks(deps);
    expect(map.get('a')!.enabled).toBe(true); // fire 后未当场停用（deferDisable）——修复的核心
    settle();
    setNow(T(2026, 5, 24, 8, 0) + 1000);
    await runDueTasks(deps);
    settle();
    setNow(T(2026, 5, 25, 8, 0) + 1000);
    await runDueTasks(deps);
    settle();
    const t = map.get('a')!;
    expect(t.enabled).toBe(false); // 配额到顶经 settle 停用
    expect(t.nextRunAt).toBeNull();
  });
});

describe('scheduler · reconcile（错过待处理 + 残留账收编）', () => {
  it('离线错过跨 2 天：不 spawn、标 missedAt 为最近一次、nextRunAt 推进 future', async () => {
    const { deps, spawn, map } = makeDeps([DAY8({ nextRunAt: T(2026, 5, 23, 8, 0) })], T(2026, 5, 25, 12, 0));
    await reconcileOnBoot(deps);
    expect(spawn).not.toHaveBeenCalled();
    const t = map.get('a')!;
    expect(t.missedAt).toBe(T(2026, 5, 25, 8, 0));
    expect(t.nextRunAt).toBe(T(2026, 5, 26, 8, 0));
    expect(t.enabled).toBe(true);
  });

  it('宽限内的漏跑留给首 tick（reconcile 不当场标错过）', async () => {
    const due = T(2026, 5, 23, 8, 0);
    const { deps, map } = makeDeps([DAY8({ nextRunAt: due })], due + GRACE_MS); // 恰在宽限内
    await reconcileOnBoot(deps);
    expect(map.get('a')!.missedAt).toBeUndefined(); // 没被 reconcile 标错过
    expect(map.get('a')!.nextRunAt).toBe(due); // 游标未动，等首 tick 触发
  });

  it('超窗重开（关机超 5 分钟）→ 当场标 missedAt 进裁决区、不 spawn（打磨 6a 补验）', async () => {
    const due = T(2026, 5, 23, 8, 0);
    const { deps, spawn, map } = makeDeps([DAY8({ nextRunAt: due })], due + GRACE_MS + 1); // 恰超宽限
    await reconcileOnBoot(deps);
    expect(spawn).not.toHaveBeenCalled(); // 不擅自补跑
    const t = map.get('a')!;
    expect(t.missedAt).toBe(due); // 进「错过待处理」区，由用户执行/忽略裁决
    expect(t.nextRunAt).toBe(T(2026, 5, 24, 8, 0)); // 游标推进未来
  });

  it('残留账收编：已投递未结算（pendingFires 非空）→ 标错过取账中最新 dueAt + 销账', async () => {
    const { deps, map } = makeDeps(
      [DAY8({ nextRunAt: T(2026, 5, 26, 8, 0), pendingFires: [{ dueAt: 100, firedAt: 101 }, { dueAt: 200, firedAt: 201 }] })],
      T(2026, 5, 25, 12, 0),
    );
    await reconcileOnBoot(deps);
    const t = map.get('a')!;
    expect(t.pendingFires).toEqual([]); // 账被销
    expect(t.missedAt).toBe(200); // 最新 dueAt 接替账
  });

  it('残留账收编：已跑满任务（重验失败）→ 静默销账、不标错过', async () => {
    const { deps, map } = makeDeps(
      [DAY8({ enabled: false, nextRunAt: null, stopAfterRuns: 1, runCount: 1, pendingFires: [{ dueAt: 100, firedAt: 101 }] })],
      T(2026, 5, 25, 12, 0),
    );
    await reconcileOnBoot(deps);
    const t = map.get('a')!;
    expect(t.pendingFires).toEqual([]);
    expect(t.missedAt).toBeUndefined();
  });
});

describe('scheduler · 手动执行 / 忽略', () => {
  it('runTaskNow 补跑：spawn(manual:true, late:true)（missedAt 非空时 late）', async () => {
    const missed = T(2026, 5, 23, 8, 0);
    const { deps, spawn } = makeDeps([DAY8({ missedAt: missed, nextRunAt: T(2026, 5, 26, 8, 0) })], T(2026, 5, 25, 12, 0));
    const r = await runTaskNow(deps, 'a');
    expect(spawn).toHaveBeenCalledWith('a', { manual: true, late: true });
    expect(r).toEqual({ alreadyRunning: false });
  });

  it('runTaskNow 无 missedAt → late:false', async () => {
    const { deps, spawn } = makeDeps([DAY8({ stopAfterRuns: 3, runCount: 0 })]);
    await runTaskNow(deps, 'a');
    expect(spawn).toHaveBeenCalledWith('a', { manual: true, late: false });
  });

  it('runTaskNow 撞进行中的执行体 → 透传 alreadyRunning', async () => {
    const { deps, spawn } = makeDeps([DAY8()]);
    spawn.mockReturnValueOnce({ alreadyRunning: true });
    expect(await runTaskNow(deps, 'a')).toEqual({ alreadyRunning: true });
  });

  it('dismissMissed 只清 missedAt、不 spawn', async () => {
    const { deps, spawn, map } = makeDeps([DAY8({ missedAt: T(2026, 5, 23, 8, 0) })], T(2026, 5, 25, 12, 0));
    await dismissMissed(deps, 'a');
    expect(spawn).not.toHaveBeenCalled();
    expect(map.get('a')!.missedAt).toBeUndefined();
  });

  it('dismissMissed 对已结束 once（nextRunAt==null）→ 标 dismissed:true', async () => {
    const { deps, map } = makeDeps(
      [DAY8({ spec: { kind: 'once', at: T(2026, 5, 23, 8, 0) }, nextRunAt: null, missedAt: T(2026, 5, 23, 8, 0) })],
      T(2026, 5, 25, 12, 0),
    );
    await dismissMissed(deps, 'a');
    expect(map.get('a')!.dismissed).toBe(true);
    expect(map.get('a')!.missedAt).toBeUndefined();
  });

  it('dismissMissed 对周期任务（nextRunAt!=null）→ 不写 dismissed（防语义污染）', async () => {
    const { deps, map } = makeDeps(
      [DAY8({ missedAt: T(2026, 5, 23, 8, 0), nextRunAt: T(2026, 5, 26, 8, 0) })],
      T(2026, 5, 25, 12, 0),
    );
    await dismissMissed(deps, 'a');
    expect(map.get('a')!.dismissed).toBeUndefined();
    expect(map.get('a')!.missedAt).toBeUndefined();
  });
});
