/**
 * 后台命令登记表持久化回归（S19·G16/G18）。
 *
 * 目标问题：
 * - 记录跨重启存活（写盘后新进程能列出、能读回输出）——G16/G18 的原料。
 * - 启动扫描把遗留 running 判为 crashed 并返回，交调用方合成「因崩溃中断」触发——G18。
 * - patch 锁内 RMW：并发改不同字段都保留（对齐「RMW 整块必须入锁」铁律）。
 * - 输出边流边 append、按需读尾。
 *
 * 走 process.env.ORU_DIR 重定向 tmpdir + 动态 import（避免 paths.ts load 时锁死 ORU_DIR）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-bgcmd-store-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'test-owner';

type Store = typeof import('../../electron/main/proposals/backgroundCommandStore');
let store: Store;

function rec(id: string, over: Partial<import('../../electron/main/proposals/backgroundCommandStore').BackgroundCommandRecord> = {}) {
  return {
    id,
    ownerId: OWNER,
    agentId: 'twin',
    conversationId: 'conv-1',
    command: 'npm run build',
    pid: 12345,
    status: 'running' as const,
    exitCode: null,
    timedOut: false,
    startedAt: 1000,
    finishedAt: null,
    announcedAt: null,
    outputPath: store.backgroundOutputPath(OWNER, id),
    ...over,
  };
}

describe('backgroundCommandStore', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
    store = await import('../../electron/main/proposals/backgroundCommandStore');
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('bgcmd_record_persists_and_lists', async () => {
    await store.createBackgroundCommand(rec('bash-bg-a'));
    const got = await store.getBackgroundCommand(OWNER, 'bash-bg-a');
    expect(got?.command).toBe('npm run build');
    const forConv = await store.listBackgroundForConversation(OWNER, 'conv-1');
    expect(forConv.map((r) => r.id)).toContain('bash-bg-a');
  });

  it('bgcmd_output_append_and_tail', async () => {
    await store.createBackgroundCommand(rec('bash-bg-out'));
    await store.appendBackgroundOutput(OWNER, 'bash-bg-out', 'line 1\n');
    await store.appendBackgroundOutput(OWNER, 'bash-bg-out', 'line 2\n');
    const tail = await store.readBackgroundOutputTail(OWNER, 'bash-bg-out');
    expect(tail).toContain('line 1');
    expect(tail).toContain('line 2');
  });

  it('bgcmd_boot_scan_marks_running_as_crashed', async () => {
    await store.createBackgroundCommand(rec('bash-bg-dangling', { status: 'running' }));
    await store.createBackgroundCommand(rec('bash-bg-done', { status: 'exited', exitCode: 0 }));
    const recovered = await store.scanBackgroundOnBoot(OWNER);
    const ids = recovered.map((r) => r.id);
    expect(ids).toContain('bash-bg-dangling');
    expect(ids).not.toContain('bash-bg-done'); // 已终态的不动
    const after = await store.getBackgroundCommand(OWNER, 'bash-bg-dangling');
    expect(after?.status).toBe('crashed');
    expect(after?.finishedAt).not.toBeNull();
  });

  it('bgcmd_concurrent_patch_no_lost_update', async () => {
    await store.createBackgroundCommand(rec('bash-bg-rmw'));
    // 两个并发 patch 改不同字段：锁内 RMW 必须都保留
    await Promise.all([
      store.patchBackgroundCommand(OWNER, 'bash-bg-rmw', { exitCode: 7 }),
      store.patchBackgroundCommand(OWNER, 'bash-bg-rmw', { announcedAt: 42 }),
    ]);
    const got = await store.getBackgroundCommand(OWNER, 'bash-bg-rmw');
    expect(got?.exitCode).toBe(7);
    expect(got?.announcedAt).toBe(42);
  });
});
