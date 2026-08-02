/**
 * 单实例长连接锁（tech design §8 / PRD 红线 4）——同一飞书 App 同一时刻只允许一条长连接
 * （飞书对单 app 并发长连接有限制，多连互踢、随机丢消息）。但崩溃重启后必须能接管，不被永久锁死。
 *
 * 存活双判（防 PID 复用误判）：持有者「活着」当且仅当 isProcessAlive(pid) 且心跳 mtime 未陈旧——
 * 崩溃的持有者停止心跳→mtime 陈旧→即便 pid 被无关新进程复用而存活也判死、可接管。
 * 接管原子性（防双接管）：compare-and-delete（只删仍是那个死持有者的锁）+ O_EXCL 重建——
 * 两实例同时接管时，重建的 O_EXCL 只让一个成功，另一个落败 held。
 *
 * 纯判定函数（fs/pid/clock 注入）；真实 fs 绑定与心跳定时器（成对清理，CLAUDE.md 副作用纪律）
 * 在 gatewayWiring / adapter connect 处接。
 */

export interface LockHolder {
  pid: number;
  /** 进程启动时间戳——与 pid 一起标识「这一次运行」，配合心跳 mtime 区分 PID 复用。 */
  startedAt: number;
}

export interface LockDeps {
  /** 读锁文件：返回持有者 + 心跳 mtime；无锁返回 null。 */
  readLock(): { holder: LockHolder; mtime: number } | null;
  /** 原子排他创建（O_EXCL）：已存在返回 false。 */
  createExclusive(holder: LockHolder): boolean;
  /** compare-and-delete：仅当磁盘锁仍是 expected（pid+startedAt 一致）才删，返回是否删成。 */
  removeLock(expected: LockHolder): boolean;
  isProcessAlive(pid: number): boolean;
  now(): number;
}

export type AcquireResult = 'acquired' | 'held';

// ─────────────── 真实 fs 绑定 ───────────────

import { readFileSync, writeFileSync, unlinkSync, statSync, utimesSync } from 'node:fs';

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * 取得单实例锁（真实文件）。acquired=false 表示已有存活实例持有。持有期间定时心跳（更新 mtime）让
 * 别的实例看到「新鲜」；release 清心跳 timer + 删锁文件（成对清理，CLAUDE.md 副作用纪律）。
 */
export function acquireSingleInstance(
  lockPath: string,
  opts?: { staleMs?: number; heartbeatMs?: number },
): { acquired: boolean; release(): void } {
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = opts?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const self: LockHolder = { pid: process.pid, startedAt: Date.now() };

  const deps: LockDeps = {
    readLock: () => {
      try {
        const holder = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockHolder;
        return { holder, mtime: statSync(lockPath).mtimeMs };
      } catch {
        return null;
      }
    },
    createExclusive: (h) => {
      try {
        writeFileSync(lockPath, JSON.stringify(h), { flag: 'wx' }); // O_EXCL：已存在抛 EEXIST
        return true;
      } catch {
        return false;
      }
    },
    removeLock: (expected) => {
      try {
        const cur = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockHolder;
        if (cur.pid !== expected.pid || cur.startedAt !== expected.startedAt) return false; // 已被换成别人的锁
        unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    },
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException)?.code === 'EPERM'; // EPERM=存在无权限；ESRCH=不存在
      }
    },
    now: () => Date.now(),
  };

  const acquired = tryAcquireLock(deps, self, staleMs) === 'acquired';
  let timer: ReturnType<typeof setInterval> | null = null;
  if (acquired && heartbeatMs > 0) {
    timer = setInterval(() => {
      try {
        const t = new Date();
        utimesSync(lockPath, t, t);
      } catch {
        /* 锁文件被外部删了——下次 acquire 自然重建，心跳静默 */
      }
    }, heartbeatMs);
    timer.unref?.();
  }
  return {
    acquired,
    release: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // compare-and-delete：只删仍是自己的锁——若曾因心跳陈旧被别的实例接管，别误删接管者的锁。
      if (acquired) deps.removeLock(self);
    },
  };
}

export function tryAcquireLock(deps: LockDeps, self: LockHolder, staleMs: number): AcquireResult {
  // 1. 无锁时直接抢（O_EXCL 原子）
  if (deps.createExclusive(self)) return 'acquired';

  // 2. 已有锁——读持有者
  const cur = deps.readLock();
  if (!cur) return deps.createExclusive(self) ? 'acquired' : 'held'; // 刚好被清，重试一次

  // 3. 双判存活：pid 存活 且 心跳新鲜 → 真有人持有，挡住
  const fresh = deps.now() - cur.mtime < staleMs;
  if (deps.isProcessAlive(cur.holder.pid) && fresh) return 'held';

  // 4. 死锁 / 陈旧 → 接管：compare-and-delete 后 O_EXCL 重建，任一步落败说明别人抢先 → held
  if (!deps.removeLock(cur.holder)) return 'held';
  return deps.createExclusive(self) ? 'acquired' : 'held';
}
