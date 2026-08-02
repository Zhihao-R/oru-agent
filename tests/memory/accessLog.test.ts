/**
 * memory/accessLog.ts 单元测试
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 包一层 spy 验证 flush 走 safeWriteAsync（原子写内核）；实现仍是真函数，不改写盘行为
vi.mock('../../electron/main/fs/safeWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/fs/safeWrite')>();
  return {
    ...actual,
    safeWriteAsync: vi.fn(actual.safeWriteAsync),
  } satisfies typeof import('../../electron/main/fs/safeWrite');
});

const ORU_DIR = join(tmpdir(), `oru-test-accesslog-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

describe('memory/accessLog', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    const { __resetForTest } = await import('../../electron/main/memory/accessLog');
    __resetForTest();
  });

  it('未记过的文件 getAccessTime 返回 null', async () => {
    const { getAccessTime } = await import('../../electron/main/memory/accessLog');
    expect(await getAccessTime('owner-x', '/tmp/nope.md')).toBeNull();
  });

  it('recordAccess 后 getAccessTime 拿到时间', async () => {
    const { recordAccess, getAccessTime } = await import(
      '../../electron/main/memory/accessLog'
    );
    const now = 1700000000000;
    await recordAccess('owner-y', '/tmp/foo.md', now);
    expect(await getAccessTime('owner-y', '/tmp/foo.md')).toBe(now);
  });

  it('flushAll 后 .access-log.json 可在磁盘读到', async () => {
    const { recordAccess, flushAll } = await import(
      '../../electron/main/memory/accessLog'
    );
    const { accessLogPath } = await import('../../electron/main/memory/paths');
    await recordAccess('owner-z', '/tmp/bar.md', 1234567);
    await flushAll();
    const text = await fs.readFile(accessLogPath('owner-z'), 'utf-8');
    const map = JSON.parse(text);
    expect(map['/tmp/bar.md']).toEqual({ count: 1, firstAt: 1234567, lastAt: 1234567 });
  });

  it('getStaleFiles 列出超过 N 天的（按 lastAt 比较）', async () => {
    const { recordAccess, getStaleFiles } = await import(
      '../../electron/main/memory/accessLog'
    );
    const now = Date.now();
    await recordAccess('owner-stale', '/tmp/old.md', now - 5 * 24 * 60 * 60 * 1000);
    await recordAccess('owner-stale', '/tmp/recent.md', now - 1 * 24 * 60 * 60 * 1000);

    const stale3 = await getStaleFiles('owner-stale', 3, now);
    expect(stale3).toContain('/tmp/old.md');
    expect(stale3).not.toContain('/tmp/recent.md');
  });

  it('多次 recordAccess：count 累加、firstAt 不被覆盖、lastAt 更新', async () => {
    const { recordAccess, getAccessTime, getUsageStats } = await import(
      '../../electron/main/memory/accessLog'
    );
    const t0 = 1700000000000;
    await recordAccess('owner-multi', '/tmp/a.md', t0);
    await recordAccess('owner-multi', '/tmp/a.md', t0 + 1000);
    await recordAccess('owner-multi', '/tmp/a.md', t0 + 5000);

    expect(await getAccessTime('owner-multi', '/tmp/a.md')).toBe(t0 + 5000); // lastAt
    const stats = await getUsageStats('owner-multi');
    expect(stats[0]).toEqual({ path: '/tmp/a.md', count: 3, lastAt: t0 + 5000 });
  });

  it('旧格式（number 值）能被升级读取，不报错、不产生 NaN', async () => {
    const { getAccessTime, recordAccess, getUsageStats } = await import(
      '../../electron/main/memory/accessLog'
    );
    const { accessLogPath } = await import('../../electron/main/memory/paths');
    // 直接写一份旧格式磁盘文件
    const path = accessLogPath('owner-legacy');
    await fs.mkdir(join(path, '..'), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ '/tmp/legacy.md': 1690000000000 }), 'utf-8');

    // 读：旧 number → lastAt
    expect(await getAccessTime('owner-legacy', '/tmp/legacy.md')).toBe(1690000000000);
    // 再 recordAccess：升级为 count 累加，不 NaN
    await recordAccess('owner-legacy', '/tmp/legacy.md', 1690000005000);
    const stats = await getUsageStats('owner-legacy');
    expect(stats[0].count).toBe(2);
    expect(Number.isNaN(stats[0].lastAt)).toBe(false);
    expect(stats[0].lastAt).toBe(1690000005000);
  });

  it('并发首次 recordAccess 不丢更新（首次 load 合流）', async () => {
    const { recordAccess, getUsageStats } = await import(
      '../../electron/main/memory/accessLog'
    );
    const now = 1700000000000;
    // 同一 owner、缓存为空时并发触发——若各自读盘各自 set，会互相覆盖丢 count
    await Promise.all([
      recordAccess('owner-race', '/m/a.md', now),
      recordAccess('owner-race', '/m/a.md', now + 1),
      recordAccess('owner-race', '/m/b.md', now + 2),
    ]);
    const stats = await getUsageStats('owner-race');
    const a = stats.find((s) => s.path === '/m/a.md');
    const b = stats.find((s) => s.path === '/m/b.md');
    expect(a?.count).toBe(2); // 两次都计入，未被覆盖
    expect(b?.count).toBe(1);
  });

  it('getUsageStats 给出"最常读"与"从没读"两个清单', async () => {
    const { recordAccess, getUsageStats } = await import(
      '../../electron/main/memory/accessLog'
    );
    const now = 1700000000000;
    await recordAccess('owner-usage', '/m/hot.md', now);
    await recordAccess('owner-usage', '/m/hot.md', now + 1);
    await recordAccess('owner-usage', '/m/warm.md', now);

    // 不传全集：只返回被记录过的，按 count 降序 → 最常读在头部
    const recorded = await getUsageStats('owner-usage');
    expect(recorded.map((s) => s.path)).toEqual(['/m/hot.md', '/m/warm.md']);

    // 传全集：从没读的补 count:0
    const all = await getUsageStats('owner-usage', ['/m/hot.md', '/m/warm.md', '/m/cold.md']);
    const neverRead = all.filter((s) => s.count === 0).map((s) => s.path);
    expect(neverRead).toEqual(['/m/cold.md']);
    expect(all[0].path).toBe('/m/hot.md'); // 最常读仍在头部
  });

  it('坏档（半截 JSON）不抛错：load 降级空 map，后续记录与 flush 正常自愈', async () => {
    const { recordAccess, getAccessTime, flushAll } = await import(
      '../../electron/main/memory/accessLog'
    );
    const { accessLogPath } = await import('../../electron/main/memory/paths');
    const path = accessLogPath('owner-corrupt');
    await fs.mkdir(join(path, '..'), { recursive: true });
    // 模拟崩溃/断电留下的半截 JSON
    await fs.writeFile(path, '{"/tmp/half.md": {"count": 3, "fir', 'utf-8');

    // 不抛（修复前这里 rethrow SyntaxError，记忆检索永久失效）
    expect(await getAccessTime('owner-corrupt', '/tmp/half.md')).toBeNull();
    // 坏一次不再永久坏：后续记录 + flush 重建为合法 JSON
    await recordAccess('owner-corrupt', '/tmp/new.md', 42);
    await flushAll();
    const map = JSON.parse(await fs.readFile(path, 'utf-8'));
    expect(map['/tmp/new.md']).toEqual({ count: 1, firstAt: 42, lastAt: 42 });
  });

  it('flush 落盘走 safeWriteAsync（原子写内核），且写出的文件可 parse', async () => {
    const { recordAccess, flushAll } = await import('../../electron/main/memory/accessLog');
    const { accessLogPath } = await import('../../electron/main/memory/paths');
    const { safeWriteAsync } = await import('../../electron/main/fs/safeWrite');
    vi.mocked(safeWriteAsync).mockClear();

    await recordAccess('owner-atomic', '/tmp/x.md', 1);
    await flushAll();

    expect(vi.mocked(safeWriteAsync)).toHaveBeenCalledWith(
      accessLogPath('owner-atomic'),
      expect.any(String),
    );
    const map = JSON.parse(await fs.readFile(accessLogPath('owner-atomic'), 'utf-8'));
    expect(map['/tmp/x.md']).toEqual({ count: 1, firstAt: 1, lastAt: 1 });
  });
});
