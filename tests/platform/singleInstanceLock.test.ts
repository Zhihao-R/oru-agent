/**
 * 单实例长连接锁（tech design §8，§11 对抗 critical）——同一飞书 App 同一时刻只允许一条长连接。
 * 红线 4：检测到旧实例已退出就接管，不能崩溃重启后被永久锁死。
 *
 * 双判存活：isProcessAlive(pid) AND 心跳 mtime 未陈旧——崩溃的持有者停止心跳→mtime 陈旧→即便
 * PID 被无关新进程复用（alive）也判死可接管（防 PID 复用误判）。接管走 compare-and-delete + 原子
 * O_EXCL 重建，两实例同时接管时只一个赢（防双接管）。注入 fs/pid/clock，纯测。
 */
import { describe, expect, it, vi } from 'vitest';
import { tryAcquireLock, type LockDeps, type LockHolder } from '../../electron/main/platform/singleInstanceLock';

const STALE_MS = 30_000;
const self: LockHolder = { pid: 1000, startedAt: 5_000 };

/** 造一套 fake fs/pid/clock。state.file 模拟磁盘锁文件。 */
function makeDeps(
  opts: { file?: { holder: LockHolder; mtime: number } | null; alivePids?: number[]; now?: number; methods?: Partial<LockDeps> } = {},
) {
  let file = opts.file ?? null;
  const alive = new Set(opts.alivePids ?? []);
  const now = opts.now ?? 100_000;
  const deps: LockDeps = {
    readLock: () => file,
    createExclusive: (h) => {
      if (file) return false; // O_EXCL：已存在则失败
      file = { holder: h, mtime: now };
      return true;
    },
    removeLock: (expected) => {
      if (!file) return false;
      if (file.holder.pid !== expected.pid || file.holder.startedAt !== expected.startedAt) return false; // compare-and-delete
      file = null;
      return true;
    },
    isProcessAlive: (pid) => alive.has(pid),
    now: () => now,
    ...opts.methods,
  };
  return { deps, getFile: () => file };
}

describe('tryAcquireLock', () => {
  it('无锁 → 取得', () => {
    const { deps, getFile } = makeDeps({ file: null });
    expect(tryAcquireLock(deps, self, STALE_MS)).toBe('acquired');
    expect(getFile()?.holder).toEqual(self);
  });

  it('持有者存活且心跳新鲜 → 挡住（held）', () => {
    const holder = { pid: 2000, startedAt: 9_000 };
    const { deps } = makeDeps({ file: { holder, mtime: 100_000 }, alivePids: [2000], now: 110_000 });
    expect(tryAcquireLock(deps, self, STALE_MS)).toBe('held');
  });

  it('持有者已退出（pid 不存活）→ 接管', () => {
    const holder = { pid: 2000, startedAt: 9_000 };
    const { deps, getFile } = makeDeps({ file: { holder, mtime: 100_000 }, alivePids: [], now: 110_000 });
    expect(tryAcquireLock(deps, self, STALE_MS)).toBe('acquired');
    expect(getFile()?.holder).toEqual(self);
  });

  it('PID 复用（pid 存活但心跳陈旧）→ 判死接管，不误判存活', () => {
    const holder = { pid: 2000, startedAt: 9_000 };
    // mtime 距今 60s > STALE 30s：原持有者崩了停止心跳，pid 2000 被别的进程复用而存活
    const { deps } = makeDeps({ file: { holder, mtime: 50_000 }, alivePids: [2000], now: 110_000 });
    expect(tryAcquireLock(deps, self, STALE_MS)).toBe('acquired');
  });

  it('两实例同时接管：compare-and-delete 后 O_EXCL 重建竞态，落败方 held', () => {
    const holder = { pid: 2000, startedAt: 9_000 };
    const { deps } = makeDeps({ file: { holder, mtime: 100_000 }, alivePids: [], now: 200_000 });
    // 模拟：本实例 removeLock 后、createExclusive 前，另一实例已抢先建锁
    const realCreate = deps.createExclusive;
    let firstCreate = true;
    deps.createExclusive = vi.fn((h) => {
      if (firstCreate) {
        firstCreate = false;
        // 抢先：制造一个别人已建好的锁，使本次 O_EXCL 失败
        deps.readLock = () => ({ holder: { pid: 3000, startedAt: 1 }, mtime: 200_000 });
        return false;
      }
      return realCreate(h);
    });
    expect(tryAcquireLock(deps, self, STALE_MS)).toBe('held');
  });

  it('compare-and-delete 防误删：读到的持有者已被换成别人的新锁 → 不接管', () => {
    const holder = { pid: 2000, startedAt: 9_000 };
    const { deps } = makeDeps({ file: { holder, mtime: 50_000 }, alivePids: [], now: 110_000 });
    // removeLock 时磁盘上已是另一个持有者（pid 9999）→ compare-and-delete 失败
    deps.removeLock = () => false;
    expect(tryAcquireLock(deps, self, STALE_MS)).toBe('held');
  });
});
