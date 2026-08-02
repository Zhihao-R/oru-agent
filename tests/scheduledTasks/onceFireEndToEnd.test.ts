/**
 * 一次性定时任务「到点真执行」端到端回归（S18·critical 修复）
 *
 * 补 split-brain 漏网：scheduler.test 把 spawn 做成 spy（从不跑 driveRun）、executor.test 直接
 * 设 enabled:false 模拟「用户暂停」——两套各测接缝一侧，中间 recordFire↔driveRun 重验的交接无人覆盖。
 * 本文件用一个共享内存 store 把真 fireDueTask（scheduler）与真 driveRun（executor.spawnScheduledRun）
 * 串起来，锁死不变量：once 任务到点必须真跑一次（runConversation 被调、runCount===1、有产出对话）。
 *
 * bug（修复前）：fireDueTask→recordFire 对 once 提前把 enabled 翻 false，driveRun 开跑前重验读到
 * enabled:false 当「已暂停」→ discardFires 空转返回 → 一次性任务 100% 到点不执行、还静默显示「未能触发」。
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ScheduledTask, PendingFire } from '@shared/types';
import { fireDueTask, type SchedulerDeps } from '../../electron/main/scheduledTasks/scheduler';
import {
  spawnScheduledRun,
  configureExecutor,
  abortAllScheduledRuns,
  type ExecutorDeps,
  type ScheduledRunResult,
} from '../../electron/main/scheduledTasks/executor';

const flush = () => new Promise((r) => setTimeout(r, 10));
const DUE = Date.UTC(2026, 5, 24, 10, 0);

const onceTask = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 'once1',
  ownerId: 'o',
  agentId: 'twin',
  title: '打个招呼',
  prompt: '用一句话跟我打个招呼',
  runLocation: { kind: 'newConversation' },
  spec: { kind: 'once', at: DUE },
  enabled: true,
  createdBy: 'user',
  nextRunAt: DUE,
  runCount: 0,
  tz: 'UTC',
  pendingFires: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

/** 一个共享 store，同时喂给 SchedulerDeps（recordFire）与 ExecutorDeps（getTask/settleRun）。
 *  两侧的 recordFire/settleRun 忠实镜像真实 store.ts 语义（含本次修复：终态停用收敛到 settle）。 */
function wireSharedStore(seed: ScheduledTask[], nowMs: number) {
  const map = new Map(seed.map((t) => [t.id, structuredClone(t)]));
  const calls = { ran: [] as string[], landed: [] as string[] };

  const sched: SchedulerDeps = {
    now: () => nowMs,
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
      const advance = computeAdvance(structuredClone(cur));
      const next: ScheduledTask = {
        ...cur,
        nextRunAt: advance.nextRunAt,
        enabled: advance.enabled,
        pendingFires: [...(cur.pendingFires ?? []), fire],
      };
      map.set(id, next);
      return structuredClone(next);
    },
    reconcileFires: async () => null,
    // 真执行体：把 fire-and-forget 接到真 driveRun
    spawn: (id, opts) => spawnScheduledRun(id, opts),
  };

  const exec: ExecutorDeps = {
    now: () => nowMs,
    getTask: async (id) => (map.has(id) ? structuredClone(map.get(id)!) : null),
    settleRun: async (id, run, opts) => {
      const cur = map.get(id);
      if (!cur) return null;
      const cleared = (cur.pendingFires ?? []).length;
      const runCount = cur.runCount + (cleared >= 1 ? 1 : 0);
      // 镜像修复后 store.settleRun：once / stopAfterRuns 到顶 → 终态停用收敛到结算单点
      const spent = cur.spec.kind === 'once' || (cur.stopAfterRuns != null && runCount >= cur.stopAfterRuns);
      const next: ScheduledTask = {
        ...cur,
        lastRun: run,
        runCount,
        enabled: spent ? false : cur.enabled,
        pendingFires: [],
        ...(opts?.clearMissed ? { missedAt: undefined } : {}),
      };
      map.set(id, next);
      return structuredClone(next);
    },
    discardFires: async (id) => {
      const cur = map.get(id);
      if (cur) map.set(id, { ...cur, pendingFires: [] });
    },
    clearMissed: async () => {},
    resolveConversation: async (t) => ({ agentId: 'ag', conversationId: `conv-${t.id}` }),
    ensureLandable: async (agentId, conversationId) => ({ agentId, conversationId }),
    readSnapshot: async () => [],
    runConversation: async ({ task }) => {
      calls.ran.push(task.id);
      return { text: '你好', status: 'ok' } satisfies ScheduledRunResult;
    },
    landResult: async ({ task }) => {
      calls.landed.push(task.id);
    },
    broadcastStarted: () => {},
  };

  configureExecutor(exec);
  return { map, calls, sched };
}

afterEach(() => {
  abortAllScheduledRuns();
  configureExecutor(null);
});

describe('S18 · 一次性任务到点真执行（critical 回归）', () => {
  it('once 任务 fireDueTask 后真跑一次：runConversation 被调、runCount===1、有产出对话、终态停用', async () => {
    const { map, calls, sched } = wireSharedStore([onceTask()], DUE + 1000);
    await fireDueTask(sched, 'once1', DUE);
    await flush();

    const t = map.get('once1')!;
    expect(calls.ran).toEqual(['once1']); // 真的跑了会话，不是被 discard 掉
    expect(calls.landed).toEqual(['once1']); // 产出真落进对话
    expect(t.runCount).toBe(1); // 计了一次
    expect(t.enabled).toBe(false); // 跑过即终态停用（收敛在 settle）
    expect(t.nextRunAt).toBeNull(); // 一次无下次
    expect(t.pendingFires ?? []).toHaveLength(0); // 账已结清
  });

  it('普通每日任务不受影响：fire 后 enabled 仍 true（终态停用只对 once/末次）', async () => {
    const daily = onceTask({
      id: 'daily1',
      spec: { kind: 'daily', minutesOfDay: 600 },
      nextRunAt: DUE,
    });
    const wired = wireSharedStore([daily], DUE + 1000);
    await fireDueTask(wired.sched, 'daily1', DUE);
    await flush();

    const t = wired.map.get('daily1')!;
    expect(wired.calls.ran).toEqual(['daily1']);
    expect(t.enabled).toBe(true); // 周期任务跑完仍启用
    expect(t.runCount).toBe(1);
  });
});
