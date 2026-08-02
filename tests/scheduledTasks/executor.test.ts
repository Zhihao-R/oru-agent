/**
 * 定时任务后台执行体编排回归（S18·G98/G43）——注入 fake ExecutorDeps 驱动 spawnScheduledRun。
 *
 * 覆盖技术方案 §9「执行体」条：
 * - 同任务 inflight 时新拍不另起、账合并结算（只 settle 一次）
 * - 手动执行撞 inflight → 清 missedAt + 返回 alreadyRunning
 * - 开跑前重验失败（到点拍：删除/暂停/已跑满）→ discardFires、不 settle/land；手动批仅删除才失败
 * - 执行成功/失败 → settle + land 照落、不重排
 * - 应用退出 abort → 不结算、不落结果
 * - 结算后重扫非空再跑（孤账竞态回归）
 * - buildScheduledHistory 跨后端契约：history 末尾 user 轮＝触发文本
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ScheduledTask } from '@shared/types';
import {
  spawnScheduledRun,
  configureExecutor,
  abortAllScheduledRuns,
  getInflightScheduledRuns,
  buildScheduledHistory,
  type ExecutorDeps,
  type ScheduledRunResult,
} from '../../electron/main/scheduledTasks/executor';

const flush = () => new Promise((r) => setTimeout(r, 10));

const task = (id: string, over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id,
  ownerId: 'o',
  agentId: 'twin',
  title: '每日简报',
  prompt: '汇总',
  runLocation: { kind: 'newConversation' },
  spec: { kind: 'daily', minutesOfDay: 480 },
  enabled: true,
  createdBy: 'user',
  nextRunAt: 999,
  runCount: 0,
  tz: 'UTC',
  pendingFires: [{ dueAt: 100, firedAt: 100 }],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

function makeFakeDeps(seed: ScheduledTask[], over: Partial<ExecutorDeps> = {}) {
  const store = new Map(seed.map((t) => [t.id, structuredClone(t)]));
  const calls = {
    settle: [] as Array<{ id: string; run: NonNullable<ScheduledTask['lastRun']>; opts?: { clearMissed?: boolean } }>,
    discard: [] as string[],
    clearMissed: [] as string[],
    land: [] as Array<{ conversationId: string; result: ScheduledRunResult }>,
    started: [] as Array<{ conversationId: string; taskId: string }>,
  };
  const deps: ExecutorDeps = {
    now: () => 1000,
    getTask: async (id) => (store.has(id) ? structuredClone(store.get(id)!) : null),
    settleRun: async (id, run, opts) => {
      calls.settle.push({ id, run, opts });
      const cur = store.get(id);
      if (!cur) return null;
      const cleared = (cur.pendingFires ?? []).length;
      const next: ScheduledTask = {
        ...cur,
        lastRun: run,
        runCount: cur.runCount + (cleared >= 1 ? 1 : 0),
        pendingFires: [],
        ...(opts?.clearMissed ? { missedAt: undefined } : {}),
      };
      store.set(id, next);
      return structuredClone(next);
    },
    discardFires: async (id) => {
      calls.discard.push(id);
      const cur = store.get(id);
      if (cur) store.set(id, { ...cur, pendingFires: [] });
    },
    clearMissed: async (id) => {
      calls.clearMissed.push(id);
    },
    resolveConversation: async (t) => ({ agentId: 'ag', conversationId: `conv-${t.id}` }),
    ensureLandable: async (agentId, conversationId) => ({ agentId, conversationId }),
    readSnapshot: async () => [],
    runConversation: async () => ({ text: '产出原文', status: 'ok' }),
    landResult: async ({ conversationId, result }) => {
      calls.land.push({ conversationId, result });
    },
    broadcastStarted: ({ conversationId, taskId }) => {
      calls.started.push({ conversationId, taskId });
    },
    ...over,
  };
  return { deps, calls, store };
}

afterEach(() => {
  abortAllScheduledRuns();
  configureExecutor(null);
});

describe('executor · 串行合并（inflight）', () => {
  it('同任务在跑时新拍不另起、账合并只结算一次', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, calls } = makeFakeDeps([task('t1')], {
      runConversation: async () => {
        await gate;
        return { text: 'x', status: 'ok' };
      },
    });
    configureExecutor(deps);
    const r1 = spawnScheduledRun('t1', {});
    await flush(); // 让 driveRun 走到 runConversation 挂在 gate 上
    const r2 = spawnScheduledRun('t1', {}); // inflight → 不另起
    expect(r1.alreadyRunning).toBe(false);
    expect(r2.alreadyRunning).toBe(true);
    expect(getInflightScheduledRuns()).toEqual(['t1']);
    release();
    await flush();
    expect(calls.settle).toHaveLength(1); // 合并：只结算一次
    expect(getInflightScheduledRuns()).toEqual([]);
  });

  it('手动执行撞 inflight → 清 missedAt + 返回 alreadyRunning', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, calls } = makeFakeDeps([task('t1')], {
      runConversation: async () => {
        await gate;
        return { text: 'x', status: 'ok' };
      },
    });
    configureExecutor(deps);
    spawnScheduledRun('t1', {});
    await flush();
    const r = spawnScheduledRun('t1', { manual: true });
    expect(r.alreadyRunning).toBe(true);
    expect(calls.clearMissed).toEqual(['t1']);
    release();
    await flush();
  });
});

describe('executor · 开跑前重验', () => {
  it('到点拍：任务已暂停 → discardFires、不 settle/land', async () => {
    const { deps, calls } = makeFakeDeps([task('t1', { enabled: false })]);
    configureExecutor(deps);
    spawnScheduledRun('t1', { manual: false });
    await flush();
    expect(calls.discard).toEqual(['t1']);
    expect(calls.settle).toHaveLength(0);
    expect(calls.land).toHaveLength(0);
  });

  it('到点拍：已跑满（runCount>=stopAfterRuns）→ discardFires、不 settle', async () => {
    const { deps, calls } = makeFakeDeps([task('t1', { stopAfterRuns: 2, runCount: 2 })]);
    configureExecutor(deps);
    spawnScheduledRun('t1', { manual: false });
    await flush();
    expect(calls.discard).toEqual(['t1']);
    expect(calls.settle).toHaveLength(0);
  });

  it('手动批：暂停任务仍执行（不静默失效），不 discard', async () => {
    const { deps, calls } = makeFakeDeps([task('t1', { enabled: false, pendingFires: [] })]);
    configureExecutor(deps);
    spawnScheduledRun('t1', { manual: true });
    await flush();
    expect(calls.discard).toHaveLength(0);
    expect(calls.settle).toHaveLength(1);
    expect(calls.land).toHaveLength(1);
  });

  it('手动批：任务已删 → 不 settle、不 discard', async () => {
    const { deps, calls } = makeFakeDeps([]);
    configureExecutor(deps);
    spawnScheduledRun('gone', { manual: true });
    await flush();
    expect(calls.settle).toHaveLength(0);
    expect(calls.discard).toHaveLength(0);
  });
});

describe('executor · 结算与落盘', () => {
  it('成功：settle(status=ok, late 清 missedAt) + land 结果', async () => {
    const { deps, calls } = makeFakeDeps([task('t1', { missedAt: 50 })]);
    configureExecutor(deps);
    spawnScheduledRun('t1', { manual: false, late: true });
    await flush();
    expect(calls.settle[0].run.status).toBe('ok');
    expect(calls.settle[0].run.late).toBe(true);
    expect(calls.settle[0].opts?.clearMissed).toBe(true);
    expect(calls.land[0].result.status).toBe('ok');
  });

  it('失败：settle(status=error) + land 照落、不重排', async () => {
    const { deps, calls } = makeFakeDeps([task('t1')], {
      runConversation: async () => ({ text: '', status: 'error', error: '模型挂了' }),
    });
    configureExecutor(deps);
    spawnScheduledRun('t1', { manual: false });
    await flush();
    expect(calls.settle[0].run.status).toBe('error');
    expect(calls.settle[0].run.error).toBe('模型挂了');
    expect(calls.land).toHaveLength(1);
  });

  it('开跑广播「执行中」', async () => {
    const { deps, calls } = makeFakeDeps([task('t1')]);
    configureExecutor(deps);
    spawnScheduledRun('t1', {});
    await flush();
    expect(calls.started).toEqual([{ conversationId: 'conv-t1', taskId: 't1' }]);
  });

  it('承载对话跑会话期间被换掉 → 运行记录与落盘都用重解析后的对话（G45 不指错）', async () => {
    const { deps, calls } = makeFakeDeps([task('t1')], {
      // 模拟：原承载对话已不可用，敲定为另一条
      ensureLandable: async () => ({ agentId: 'ag', conversationId: 'conv-relanded' }),
    });
    configureExecutor(deps);
    spawnScheduledRun('t1', { manual: false });
    await flush();
    expect(calls.settle[0].opts?.conversationId).toBe('conv-relanded'); // 运行记录钉到真正落盘处
    expect(calls.land[0].conversationId).toBe('conv-relanded'); // 落盘也用它
  });
});

describe('executor · 退出中止不结算', () => {
  it('执行中被 abort（应用退出）→ 不 settle、不 land，inflight 清空', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { deps, calls } = makeFakeDeps([task('t1')], {
      runConversation: async ({ abortController }) => {
        await gate;
        if (abortController.signal.aborted) throw new Error('aborted');
        return { text: 'x', status: 'ok' };
      },
    });
    configureExecutor(deps);
    spawnScheduledRun('t1', {});
    await flush();
    abortAllScheduledRuns(); // 应用退出
    release();
    await flush();
    expect(calls.settle).toHaveLength(0); // 退出中止不结算
    expect(calls.land).toHaveLength(0);
    expect(getInflightScheduledRuns()).toEqual([]);
  });
});

describe('executor · 结算后重扫（孤账竞态）', () => {
  it('结算后账非空（跑期间又落一拍）→ 再 drain 一轮', async () => {
    const { deps, calls, store } = makeFakeDeps([task('t1')]);
    // 让首次 runConversation 期间模拟又落了一笔到点账（settle 清完后 getTask 仍见新账）
    let firstRun = true;
    deps.runConversation = async () => {
      if (firstRun) {
        firstRun = false;
        // settle 会清账；这里在 settle 之前往 store 补一笔「结算读取后落的」新账，
        // 由 settle 清掉当前账后、重扫读到——用 settle 后再补的方式模拟窄窗：改为 land 时补账
      }
      return { text: 'x', status: 'ok' };
    };
    // 用 landResult 钩子模拟「结算之后、重扫之前」又落一拍新账（只补一次，避免无限）
    let injected = false;
    const origLand = deps.landResult;
    deps.landResult = async (p) => {
      await origLand(p);
      if (!injected) {
        injected = true;
        const cur = store.get('t1')!;
        store.set('t1', { ...cur, pendingFires: [{ dueAt: 200, firedAt: 200 }] });
      }
    };
    configureExecutor(deps);
    spawnScheduledRun('t1', {});
    await flush();
    // 首轮 settle + 重扫触发的第二轮 settle
    expect(calls.settle.length).toBe(2);
  });
});

describe('executor · buildScheduledHistory 跨后端契约', () => {
  it('history 末尾是 user 轮、text＝触发文本（唯一跨后端坑的化解）', () => {
    const snapshot = [
      { id: 'm1', conversationId: 'c', role: 'assistant' as const, text: '早', toolCalls: [], createdAt: 1, done: true },
    ];
    const h = buildScheduledHistory(snapshot, 'sched_x', '<scheduled-task-trigger>...');
    expect(h).toHaveLength(2);
    const last = h[h.length - 1];
    expect(last.role).toBe('user');
    expect(last.text).toBe('<scheduled-task-trigger>...');
    expect(last.conversationId).toBe('sched_x');
    expect(h[0]).toBe(snapshot[0]); // 快照原样在前
  });
});
