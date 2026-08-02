/**
 * dreamScheduler.runOnce 行为测试
 *
 * 核心不变量：
 * - failed 退避：newEpisodeCount 清到半阈值——再积一半阈值才重试，不会每条写入都轰炸
 * - 成功（ok 或合法 skipped）清零 newEpisodeCount
 * - 并发保护：inFlight 时返回 { kind: 'skipped', reason: 'concurrent-run' }
 * - inFlight 必须复位（无论 runDream 是 resolve 还是 reject）
 * - leading debounce：pending timer 唯一，重复触发返回 'debounce-pending'，stop() 一刀全断
 *
 * v2：dream 改固定近 30 天窗口、不再用 sinceMs 游标 / lastDreamAt——原 sinceMs 推进测试已移除。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import type { DreamRunOutcome } from '../../shared/types';
import type { EpisodeSummary } from '../../electron/main/memory/store';

// 状态文件 .dream-state.json 走真实 fs——追跑判据要"重读存活，证非内存"。
// ORU_DIR 在 runtime/paths 模块顶层 const 读取，必须在任何 import 求值前设好，故走 vi.hoisted。
// process.env 在同 worker 跨文件共享——捕获原值并在 afterAll 还原，不把本文件的沙箱路径泄漏给兄弟文件。
const { prevOruDir } = vi.hoisted(() => {
  const prev = process.env.ORU_DIR;
  process.env.ORU_DIR = `/tmp/oru-test-dreamsched-${process.pid}`;
  return { prevOruDir: prev };
});
afterAll(() => {
  if (prevOruDir === undefined) delete process.env.ORU_DIR;
  else process.env.ORU_DIR = prevOruDir;
});

const runDreamMock = vi.fn<
  [{ ownerId: string; currentProjectId: string | null }],
  Promise<DreamRunOutcome>
>();

vi.mock('../../electron/main/memory/dream', () => ({
  runDream: (args: { ownerId: string; currentProjectId: string | null }) => runDreamMock(args),
}));

// runOnce 末尾 await 真实 archiver（fs IO）——fake timers 下它不结束 inFlight 就不释放，
// 后续触发全被 concurrent-run 挡掉；mock 成秒回让 inFlight 释放确定性
vi.mock('../../electron/main/memory/archiver', () => ({
  archiveOldSuperseded: () => Promise.resolve(),
}));

// hasUnreviewedEpisodes 复用 store 的 active 扫描——mock 锚到真实签名（typeof import + satisfies），
// 签名漂移（含 EpisodeSummary 变形）即红，不裸对象 as 蒙混
const listEpisodesMock =
  vi.fn<(typeof import('../../electron/main/memory/store'))['listAllEpisodesWithSuperseded']>();
vi.mock('../../electron/main/memory/store', () => {
  return {
    listAllEpisodesWithSuperseded: (owner, includeSuperseded) =>
      listEpisodesMock(owner, includeSuperseded),
  } satisfies Partial<typeof import('../../electron/main/memory/store')>;
});

// safeWriteAsync 同步化：dreamScheduler 的 writeLastDreamAt 走它（tmp+rename 真实 fs 宏任务）。
// 「假定时器」测试用 advanceTimersByTimeAsync 推进，只清微任务、不等真实磁盘 IO——那次 rename 的
// 尾巴会留到测试结束后才落地，晚一拍跨测试覆盖共享的 .dream-state.json，使追跑测试偶发读到他人
// 时间戳→误判 window-not-missed→该触发的 dream 没触发→waitFor 超时（~20% flaky）。改为同步写：
// 仍真实落盘（追跑测试「重读存活」语义不变），但无悬空 IO，竞态从根上消除。其余导出保持真实。
vi.mock('../../electron/main/fs/safeWrite', async (importActual) => {
  const actual = await importActual<typeof import('../../electron/main/fs/safeWrite')>();
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  return {
    ...actual,
    safeWriteAsync: async (absPath: string, content: string): Promise<void> => {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, 'utf-8');
    },
  } satisfies typeof import('../../electron/main/fs/safeWrite');
});

import {
  runOnce,
  scheduleSoon,
  onEpisodeWritten,
  stop,
  __resetForTest,
  maybeCatchUp,
  mostRecentDreamHour,
} from '../../electron/main/memory/dreamScheduler';
import { dreamStatePath } from '../../electron/main/memory/paths';

const ok: DreamRunOutcome = {
  kind: 'ok',
  episodesMerged: 0,
  userFactsChanged: 0,
  projectFieldsChanged: 0,
  profileWrites: [],
};
describe('dreamScheduler.runOnce', () => {
  beforeEach(() => {
    runDreamMock.mockReset();
    __resetForTest();
  });

  it('runDream 拿到 ownerId + currentProjectId（不再传 sinceMs）', async () => {
    runDreamMock.mockResolvedValue(ok);
    await runOnce('manual');
    expect(runDreamMock).toHaveBeenCalledOnce();
    const arg = runDreamMock.mock.calls[0][0];
    expect(arg).toHaveProperty('ownerId');
    expect(arg).toHaveProperty('currentProjectId');
    expect(arg).not.toHaveProperty('sinceMs');
  });

  // 并发保护是 scheduler 的核心合约——这条专门锁住
  it('inFlight 时第二次调用立刻返回 skipped/concurrent-run，不重入 runDream', async () => {
    // 用一个永不 resolve 的 promise 让第一次 runOnce 一直占着 inFlight
    let resolveFirst!: (s: DreamRunOutcome) => void;
    runDreamMock.mockImplementationOnce(
      () =>
        new Promise<DreamRunOutcome>((r) => {
          resolveFirst = r;
        }),
    );
    const p1 = runOnce('manual');
    const r2 = await runOnce('manual'); // 这次应秒返
    expect(r2).toEqual({ kind: 'skipped', reason: 'concurrent-run' });
    expect(runDreamMock).toHaveBeenCalledOnce(); // 第二次没真调
    resolveFirst(ok);
    await p1;
  });

  // runDream 契约是 "永不抛"，但 scheduler 的 inFlight 保护要对违反契约的输入也成立——
  // 这条不关心 runOnce 自己抛不抛（那是 implementation detail），只锁 "inFlight 必须复位"
  it('即使 runDream 违反契约抛错，下一次 runOnce 仍能正常进入（inFlight 复位）', async () => {
    runDreamMock.mockRejectedValueOnce(new Error('contract violation'));
    // 抛不抛随实现；我们只关心后续状态
    await runOnce('manual').catch(() => undefined);

    runDreamMock.mockResolvedValueOnce(ok);
    const r2 = await runOnce('manual');
    expect(r2.kind).toBe('ok');
  });

  // N3：stop() 必须取消去抖中的 dream，否则退出后仍落盘
  it('stop() 取消阈值触发的去抖 dream，runDream 不被调用', async () => {
    vi.useFakeTimers();
    try {
      runDreamMock.mockResolvedValue(ok);
      // 跨过 20 条阈值 → 触发 scheduleSoon（30s 去抖）
      for (let i = 0; i < 20; i += 1) onEpisodeWritten();
      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runDreamMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dreamScheduler 去抖（leading debounce）', () => {
  beforeEach(() => {
    runDreamMock.mockReset();
    __resetForTest();
  });

  it('pending 期间再调 scheduleSoon 返回 skipped/debounce-pending，pending 那次照常跑', async () => {
    vi.useFakeTimers();
    try {
      runDreamMock.mockResolvedValue(ok);
      const p1 = scheduleSoon('episode-threshold');
      const r2 = await scheduleSoon('daily'); // 撞窗——应被守卫秒拒
      expect(r2).toEqual({ kind: 'skipped', reason: 'debounce-pending' });
      await vi.advanceTimersByTimeAsync(30_000);
      const r1 = await p1;
      expect(r1.kind).toBe('ok');
      expect(runDreamMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  // M4 主回归：旧实现每条超阈值写入都新建 timer 且互相覆盖，
  // stop() 只能取消最后一个——泄漏的 timer 仍会在退出后触发 runDream
  it('连续多条超阈值写入只产生一个 pending，stop() 一刀全断', async () => {
    vi.useFakeTimers();
    try {
      runDreamMock.mockResolvedValue(ok);
      for (let i = 0; i < 25; i += 1) onEpisodeWritten(); // 第 20~25 条都越过阈值
      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runDreamMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('连续多条超阈值写入，30s 后 dream 只跑一次', async () => {
    vi.useFakeTimers();
    try {
      runDreamMock.mockResolvedValue(ok);
      for (let i = 0; i < 25; i += 1) onEpisodeWritten();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runDreamMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dream 失败后计数退避到半阈值：再积一半阈值才重试', async () => {
    vi.useFakeTimers();
    try {
      runDreamMock.mockResolvedValue({ kind: 'failed', error: 'api key invalid' });
      for (let i = 0; i < 20; i += 1) onEpisodeWritten();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runDreamMock).toHaveBeenCalledOnce(); // 失败一次，计数退到 10

      // 再写 9 条（计数 19 < 阈值 20）——不触发
      for (let i = 0; i < 9; i += 1) onEpisodeWritten();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runDreamMock).toHaveBeenCalledOnce();

      // 第 10 条（计数 20）——重新触发
      onEpisodeWritten();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runDreamMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 启动追跑（launch / daily catch-up）────────────────────────────
//
// 触发判据：错过最近一个本地 03:00 窗口（lastDreamAt < mostRecentDreamHour）且自上次复盘后有新 episode。
// 单元测：lastDreamAt 走真实 fs（.dream-state.json），episode 扫描 mock。owner 固定 'local-user'。

const OWNER = 'local-user'; // getCurrentOwnerId() MVP 恒返此值（复用顶部已声明的 ok 夹具）

// 固定本地时刻（new Date(y,m,d,h) 即本地时区，与 mostRecentDreamHour 的 setHours 对齐）
const ASOF = new Date(2026, 5, 26, 10, 0, 0); // 2026-06-26 10:00
const TODAY_0300 = new Date(2026, 5, 26, 3, 0, 0).getTime();
const TODAY_0400 = new Date(2026, 5, 26, 4, 0, 0).getTime();
const TODAY_0900 = new Date(2026, 5, 26, 9, 0, 0).getTime();
const TODAY_0200 = new Date(2026, 5, 26, 2, 0, 0).getTime();
const YESTERDAY = new Date(2026, 5, 25, 12, 0, 0).getTime();

function episode(mtime: number): EpisodeSummary {
  return {
    relPath: 'agents/twin/episodes/2026-06-25-x.md',
    title: 'x',
    scope: 'agent',
    tags: [],
    status: 'active',
    mtime,
    type: 'agent',
    description: '',
    date: '2026-06-25',
  } satisfies EpisodeSummary;
}

async function setLastDreamAt(ts: number | null): Promise<void> {
  const p = dreamStatePath(OWNER);
  if (ts === null) {
    await fsp.rm(p, { force: true });
    return;
  }
  await fsp.mkdir(dreamStatePath(OWNER).replace(/[^/]+$/, ''), { recursive: true });
  await fsp.writeFile(p, JSON.stringify({ lastDreamAt: ts }), 'utf-8');
}

async function readLastDreamAtFile(): Promise<number | null> {
  try {
    const raw = await fsp.readFile(dreamStatePath(OWNER), 'utf-8');
    const v = (JSON.parse(raw) as { lastDreamAt?: unknown }).lastDreamAt;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

describe('dreamScheduler.mostRecentDreamHour', () => {
  it('返回 ≤now 的最近一个本地 03:00', () => {
    // 10:00 当天已过 3 点 → 当天 3 点
    expect(mostRecentDreamHour(new Date(2026, 5, 26, 10, 0, 0))).toBe(TODAY_0300);
    // 02:00 当天还没到 3 点 → 退到昨天 3 点
    expect(mostRecentDreamHour(new Date(2026, 5, 26, 2, 0, 0))).toBe(
      new Date(2026, 5, 25, 3, 0, 0).getTime(),
    );
    // 恰好 03:00 → 当天 3 点（"≤now"）
    expect(mostRecentDreamHour(new Date(2026, 5, 26, 3, 0, 0))).toBe(TODAY_0300);
  });
});

describe('dreamScheduler.maybeCatchUp', () => {
  beforeEach(async () => {
    runDreamMock.mockReset();
    runDreamMock.mockResolvedValue(ok);
    listEpisodesMock.mockReset();
    listEpisodesMock.mockResolvedValue([]);
    __resetForTest();
    await setLastDreamAt(null);
  });

  // ① 错过窗口 + 有新料 → 触发
  it('错过 03:00 窗口且有新 episode → 触发 dream', async () => {
    vi.useFakeTimers();
    try {
      await setLastDreamAt(YESTERDAY);
      listEpisodesMock.mockResolvedValue([episode(TODAY_0900)]);
      const p = maybeCatchUp('launch', ASOF);
      // 去抖 timer 在真实 fs 预检之后才建；waitFor 的重试间隙让真实 IO 跑完，
      // 之后再推进假时钟即可越过 30s 去抖触发 runDream
      await vi.waitFor(
        async () => {
          await vi.advanceTimersByTimeAsync(30_000);
          expect(runDreamMock).toHaveBeenCalledOnce();
        },
        { timeout: 2000 },
      );
      await p; // 等整条 runOnce（含落盘）settle，不把副作用尾巴漏给下一条用例
    } finally {
      vi.useRealTimers();
    }
  });

  // ② 今天 3 点后已跑过 → skip（连 episode 都不扫）
  it('lastDreamAt 在今天 03:00 之后 → skip window-not-missed，不扫 episode', async () => {
    await setLastDreamAt(TODAY_0400);
    const r = await maybeCatchUp('launch', ASOF);
    expect(r).toEqual({ kind: 'skipped', reason: 'window-not-missed' });
    expect(listEpisodesMock).not.toHaveBeenCalled();
    expect(runDreamMock).not.toHaveBeenCalled();
  });

  // ③ 错过窗口但无新料 → skip
  it('错过窗口但没有新 episode → skip no-new-episodes', async () => {
    await setLastDreamAt(YESTERDAY);
    listEpisodesMock.mockResolvedValue([episode(YESTERDAY - 1000)]); // mtime ≤ lastDreamAt
    const r = await maybeCatchUp('launch', ASOF);
    expect(r).toEqual({ kind: 'skipped', reason: 'no-new-episodes' });
    expect(runDreamMock).not.toHaveBeenCalled();
  });

  // ⑤ race：扫 episode 的 await 间隙 lastDreamAt 被推进 → 重检挡住，不重复跑
  it('扫描期间 lastDreamAt 被别的腿推进 → await 后重检 skip，不重复跑 dream', async () => {
    await setLastDreamAt(YESTERDAY);
    // 扫描 episode 时模拟 daily/阈值腿刚跑完并推进了 lastDreamAt
    listEpisodesMock.mockImplementation(async () => {
      await setLastDreamAt(TODAY_0400);
      return [episode(TODAY_0900)];
    });
    const r = await maybeCatchUp('launch', ASOF);
    expect(r).toEqual({ kind: 'skipped', reason: 'window-not-missed' });
    expect(runDreamMock).not.toHaveBeenCalled();
  });

  // ⑥ daily 腿：上次会话写的 episode + 本会话内存计数=0 仍触发（证修好"计数重启归零"bug）
  it('daily 腿：内存计数=0 但磁盘上有上次会话的新 episode → 仍触发', async () => {
    vi.useFakeTimers();
    try {
      __resetForTest(); // 内存 episodesSinceLastDream 归零，模拟刚启动
      await setLastDreamAt(YESTERDAY);
      listEpisodesMock.mockResolvedValue([episode(TODAY_0200)]); // 今天 3 点前写的，> lastDreamAt
      // daily 腿传调度边界 next（今天 3:00）作 asOf
      const p = maybeCatchUp('daily', new Date(TODAY_0300));
      await vi.waitFor(
        async () => {
          await vi.advanceTimersByTimeAsync(30_000);
          expect(runDreamMock).toHaveBeenCalledOnce();
        },
        { timeout: 2000 },
      );
      await p; // 等整条 runOnce（含落盘）settle，不把副作用尾巴漏给下一条用例
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dreamScheduler.runOnce 落 lastDreamAt', () => {
  beforeEach(async () => {
    runDreamMock.mockReset();
    listEpisodesMock.mockReset();
    listEpisodesMock.mockResolvedValue([]);
    __resetForTest();
    await setLastDreamAt(null);
  });

  // ④ 成功落 lastDreamAt（重读存活=证非内存）、failed 不落
  it('runDream 成功后把 lastDreamAt 落盘且重读存活；failed 不落', async () => {
    runDreamMock.mockResolvedValue(ok);
    const before = Date.now();
    await runOnce('manual');
    const after = Date.now();
    const stored = await readLastDreamAtFile();
    expect(stored).not.toBeNull();
    expect(stored!).toBeGreaterThanOrEqual(before);
    expect(stored!).toBeLessThanOrEqual(after);

    // failed：不覆盖已有 lastDreamAt（下次启动据此重试）
    await setLastDreamAt(TODAY_0400);
    runDreamMock.mockResolvedValue({ kind: 'failed', error: 'boom' });
    await runOnce('manual');
    expect(await readLastDreamAtFile()).toBe(TODAY_0400);
  });

  // ④b lastDreamAt 必须在 runDream 返回之后采样（不在 runOnce 入口预采样）。
  // 若在入口采样，dream 自己 merge/correct bump 的 episode mtime 会 > lastDreamAt，
  // 下次启动判"有新料"多跑一次空 dream → 自触发循环。这条专门锁住该 critical 不变量。
  it('lastDreamAt 在 runDream 返回之后采样（堵自触发空跑循环）', async () => {
    let tAfterRunDream = 0;
    runDreamMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20)); // 模拟 runDream 耗时（其间会 bump episode mtime）
      tAfterRunDream = Date.now();
      return ok;
    });
    await runOnce('manual');
    const stored = await readLastDreamAtFile();
    expect(stored).not.toBeNull();
    // 入口预采样会落在 ~20ms 之前 → stored < tAfterRunDream，这条会红
    expect(stored!).toBeGreaterThanOrEqual(tAfterRunDream);
  });

  // ⑦ 阈值快路绕开窗口判据：窗口未错过也照样跑（故意不查 lastDreamAt）
  it('20 条阈值快路绕开窗口判据：lastDreamAt 在窗口内也照样触发', async () => {
    vi.useFakeTimers();
    try {
      runDreamMock.mockResolvedValue(ok);
      await setLastDreamAt(TODAY_0400); // 窗口"未错过"——若走窗口判据本应 skip
      for (let i = 0; i < 20; i += 1) onEpisodeWritten();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runDreamMock).toHaveBeenCalledOnce(); // 仍跑 → 证明快路不看窗口
      expect(listEpisodesMock).not.toHaveBeenCalled(); // 快路也不扫 episode
    } finally {
      vi.useRealTimers();
    }
  });
});
