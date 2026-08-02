/**
 * keepAwake 模块单测（技术设计 §8）——引用计数守护 caffeinate 子进程。
 *
 * 锁的目标问题：
 *  ① refCount 升/降、0→1 spawn、1→0 kill。
 *  ② setEnabled(false) 强关：即时 kill，即使还有任务在跑；之后 release 因 clamp 不会减成负。
 *  ③ re-enable 后按当前 refCount 补 spawn（不丢仍活跃的信号）。
 *  ④ 平台守卫：非 darwin 下 acquire/release/setEnabled 全 no-op（不 spawn、不抛错）。
 *  ⑤ disposeKeepAwake：杀残留子进程（before-quit 无孤儿）。
 *
 * 走 mock 的 node:child_process（假 child 记录 spawn args + 可触发 kill）+ stub process.platform。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as keepAwake from '../../electron/main/keepAwake';

type SpawnRec = { args: string[]; child: FakeChild };

type FakeChild = {
  killed: boolean;
  onceHandlers: Record<string, ((...a: unknown[]) => void)[]>;
  on: (ev: string, cb: (...a: unknown[]) => void) => void;
  once: (ev: string, cb: (...a: unknown[]) => void) => void;
  kill: () => boolean;
};

const h = vi.hoisted(() => {
  const spawned: SpawnRec[] = [];
  function makeChild(): FakeChild {
    const onHandlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const onceHandlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const child: FakeChild = {
      killed: false,
      on: (ev, cb) => void (onHandlers[ev] ||= []).push(cb),
      once: (ev, cb) => void (onceHandlers[ev] ||= []).push(cb),
      kill: () => {
        child.killed = true;
        return true;
      },
    };
    return child;
  }
  return { spawned, makeChild };
});

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    const child = h.makeChild();
    h.spawned.push({ args, child });
    return child as unknown as ChildProcess;
  },
}));

// 当前平台（测试内可切 darwin / 非 darwin）
let platformOverride: NodeJS.Platform = 'darwin';
Object.defineProperty(process, 'platform', {
  configurable: true,
  get: () => platformOverride,
});

beforeEach(() => {
  h.spawned.length = 0;
  platformOverride = 'darwin';
  // 复位模块级状态（同 disposeKeepAwake 语义），保证每例从干净态起
  keepAwake.disposeKeepAwake();
});

afterEach(() => {
  keepAwake.disposeKeepAwake();
});

describe('keepAwake 引用计数', () => {
  it('0→1 acquire 拉起 caffeinate -dims，1→0 release 杀掉', async () => {
    await keepAwake.release(); // 0→0 无害
    expect(h.spawned.length).toBe(0);

    keepAwake.setEnabled(true);
    keepAwake.acquire(); // 0→1
    expect(h.spawned.length).toBe(1);
    expect(h.spawned[0].args).toEqual(['-dims']);
    expect(keepAwake.isAwakeActive()).toBe(true);

    keepAwake.acquire(); // 1→2，不重复拉起
    expect(h.spawned.length).toBe(1);

    keepAwake.release(); // 2→1，仍在跑
    expect(h.spawned[0].child.killed).toBe(false);
    keepAwake.release(); // 1→0，杀
    expect(h.spawned[0].child.killed).toBe(true);
    expect(keepAwake.isAwakeActive()).toBe(false);
  });

  it('setEnabled(false) 强关：即时 kill，即使还有任务在跑；之后 release 因 clamp 不会减成负', async () => {
    keepAwake.setEnabled(true);
    keepAwake.acquire();
    keepAwake.acquire();
    expect(keepAwake.isAwakeActive()).toBe(true);

    keepAwake.setEnabled(false); // 用户明确要停，即使 refCount=2 也即刻 kill、计数归零
    expect(h.spawned[0].child.killed).toBe(true);
    expect(keepAwake.isAwakeActive()).toBe(false);

    keepAwake.release(); // clamp：不会把计数减成负、更不会拉崩别的信号（不会重新 spawn）
    expect(h.spawned.length).toBe(1);
    expect(keepAwake.isAwakeActive()).toBe(false);
  });

  it('re-enable 后按当前 refCount 补 spawn（不丢仍活跃的信号）', async () => {
    keepAwake.setEnabled(true);
    keepAwake.acquire();
    keepAwake.setEnabled(false); // 强关
    expect(keepAwake.isAwakeActive()).toBe(false);

    keepAwake.setEnabled(true); // 还有一个信号在跑（refCount=1），re-enable 应补 spawn
    expect(h.spawned.length).toBe(2);
    expect(keepAwake.isAwakeActive()).toBe(true);

    keepAwake.release(); // 倒数第一个信号结束 → 杀
    expect(h.spawned[1].child.killed).toBe(true);
  });

  it('disposeKeepAwake 杀残留子进程（before-quit 无孤儿）', async () => {
    keepAwake.setEnabled(true);
    keepAwake.acquire();
    expect(keepAwake.isAwakeActive()).toBe(true);
    keepAwake.disposeKeepAwake();
    expect(h.spawned[0].child.killed).toBe(true);
    expect(keepAwake.isAwakeActive()).toBe(false);
  });
});

describe('keepAwake 平台守卫（非 darwin no-op）', () => {
  it('非 darwin 下 acquire/release/setEnabled 全 no-op：不 spawn、不抛错', async () => {
    platformOverride = 'linux';
    keepAwake.setEnabled(true);
    expect(() => keepAwake.acquire()).not.toThrow();
    expect(() => keepAwake.release()).not.toThrow();
    expect(h.spawned.length).toBe(0);
    expect(keepAwake.isAwakeActive()).toBe(false);
  });
});
