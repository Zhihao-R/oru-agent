/**
 * 单实例锁真实 fs 绑定（tech design §8 / 红线 4）——真临时文件验：取得→挡第二→释放→可重取。
 * 心跳 timer 在 release 里清干净（CLAUDE.md 副作用纪律）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireSingleInstance } from '../../electron/main/platform/singleInstanceLock';

let lockPath: string;
beforeEach(() => {
  lockPath = join(tmpdir(), `oru-silock-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});
afterEach(async () => {
  await fs.rm(lockPath, { force: true });
});

describe('acquireSingleInstance', () => {
  it('首次取得；持有期间第二次被挡；释放后可重取', async () => {
    const first = acquireSingleInstance(lockPath, { heartbeatMs: 0 });
    expect(first.acquired).toBe(true);

    const second = acquireSingleInstance(lockPath, { heartbeatMs: 0 });
    expect(second.acquired).toBe(false); // 同进程存活 + 锁新鲜 → 挡住

    first.release();
    const third = acquireSingleInstance(lockPath, { heartbeatMs: 0 });
    expect(third.acquired).toBe(true); // 释放后可重取
    third.release();
  });

  it('release 用 compare-and-delete：被别的实例接管后，原持有者 release 不误删接管者的锁', async () => {
    const first = acquireSingleInstance(lockPath, { heartbeatMs: 0 });
    expect(first.acquired).toBe(true);
    // 模拟接管：把锁文件内容换成「别的实例」的持有者
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: 1 }));
    first.release(); // 原持有者释放——不应删掉接管者的锁
    const after = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    expect(after.startedAt).toBe(1); // 接管者的锁仍在
  });

  it('release 清掉锁文件与心跳（无残留）', async () => {
    const h = acquireSingleInstance(lockPath, { heartbeatMs: 50 });
    expect(h.acquired).toBe(true);
    h.release();
    await expect(fs.access(lockPath)).rejects.toBeTruthy(); // 文件已删
  });
});
