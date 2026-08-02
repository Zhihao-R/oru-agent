/**
 * 表格视图偏好存储内核（tablePrefs.ts）——按 fileKey hash 寻址的 per-file JSON 托管存储。
 *
 * 承重不变量：
 *   - 读不存在 → null（偏好可丢，降级优于报错）；
 *   - 落盘带 version:1 封套，读出的 TablePrefs 不含 version；
 *   - 文件损坏 / 未知版本 → null 不 throw；
 *   - relocate(oldKey, newKey) 迁移偏好，源不存在时静默无事。
 *
 * ORU_DIR 隔离：paths.ts 是静态 import、提升到最前，已被 tests/setup 的 ORU_DIR 固化——直接读
 * 字节的断言一律以 paths 实际固化的 PATHS_ORU_DIR 为准（见下方注释）。被测模块用 await import
 * 动态加载（同 tests/tasks/store.test.ts）。owner 恒 local-user，MVP 不 mock getCurrentOwnerId。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { sandboxOruDir, assertOruDirIsolated } from '../helpers/oruDirSandbox';
import { ORU_DIR as PATHS_ORU_DIR } from '../../electron/main/runtime/paths';

// 注意：sandboxOruDir 在测试体顶层调，但 paths.ts 是静态 import（提升到最前）、已先 tests/setup
// 的 ORU_DIR 固化——故本文件走动态 import 拿到的 paths 目录 = PATHS_ORU_DIR，而非这里的 ORU_DIR。
// 沙箱调用仍保留（隔离清理用），直接读字节的断言一律以 PATHS_ORU_DIR 为准。
const ORU_DIR = sandboxOruDir('table-prefs-store');
const OWNER = 'local-user'; // getCurrentOwnerId 未 mock（MVP 恒 local-user），直接读字节按此寻址

/** 落盘文件路径（复刻实现的寻址口径，用于直接读字节做断言）。 */
function prefsFile(fileKey: string): string {
  const slug = createHash('sha256').update(fileKey, 'utf-8').digest('hex').slice(0, 32);
  return join(PATHS_ORU_DIR, 'users', OWNER, 'table-prefs', `${slug}.json`);
}

describe('tablePrefs 存储内核', () => {
  beforeAll(() => {
    assertOruDirIsolated(PATHS_ORU_DIR);
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
    await fs.rm(join(PATHS_ORU_DIR, 'users', OWNER, 'table-prefs'), { recursive: true, force: true });
  });

  it('读不存在的 fileKey → null', async () => {
    const { readTablePrefs } = await import('../../electron/main/fs/tablePrefs');
    expect(await readTablePrefs('/project/nope.csv')).toBeNull();
  });

  it('写→读 roundtrip：columnWidths + rowHeightPx 保真', async () => {
    const { readTablePrefs, writeTablePrefs } = await import('../../electron/main/fs/tablePrefs');
    const key = '/project/a.csv';
    await writeTablePrefs(key, { columnWidths: [180, 320, 120], rowHeightPx: 56 });
    expect(await readTablePrefs(key)).toEqual({ columnWidths: [180, 320, 120], rowHeightPx: 56 });
  });

  it('写→读 roundtrip：rowHeightsPx（每行覆盖，稀疏 map）保真，数值键 JSON 化为字符串键', async () => {
    const { readTablePrefs, writeTablePrefs } = await import('../../electron/main/fs/tablePrefs');
    const key = '/project/perrow.csv';
    await writeTablePrefs(key, { rowHeightPx: 28, rowHeightsPx: { 2: 60, 5: 44 } });
    // 对象字面量 {2:60} 的键运行时本就是字符串 "2"，JSON roundtrip 后仍 "2" → deepEqual 命中
    expect(await readTablePrefs(key)).toEqual({ rowHeightPx: 28, rowHeightsPx: { 2: 60, 5: 44 } });
  });

  it('稀疏 columnWidths（数组带 hole）JSON 化为 null，读回钉住此行为', async () => {
    const { readTablePrefs, writeTablePrefs } = await import('../../electron/main/fs/tablePrefs');
    const key = '/project/sparse.csv';
    const sparse: number[] = [];
    sparse[0] = 100;
    sparse[2] = 300; // 索引 1 是 hole
    await writeTablePrefs(key, { columnWidths: sparse });
    const read = await readTablePrefs(key);
    // JSON 序列化把 hole 变成 null；读回的数组第 1 位是 null（TS 类型上仍是 number[]，此处钉运行时事实）
    expect(read?.columnWidths).toEqual([100, null, 300]);
  });

  it('落盘文件含 version:1 封套，读出的 TablePrefs 不含 version', async () => {
    const { readTablePrefs, writeTablePrefs } = await import('../../electron/main/fs/tablePrefs');
    const key = '/project/env.csv';
    await writeTablePrefs(key, { rowHeightPx: 40 });
    const raw = JSON.parse(await fs.readFile(prefsFile(key), 'utf-8'));
    expect(raw.version).toBe(1);
    const read = await readTablePrefs(key);
    expect(read).not.toBeNull();
    expect('version' in (read as object)).toBe(false);
  });

  it('文件损坏（非 JSON）→ null 不 throw', async () => {
    const { readTablePrefs } = await import('../../electron/main/fs/tablePrefs');
    const key = '/project/broken.csv';
    await fs.mkdir(join(PATHS_ORU_DIR, 'users', OWNER, 'table-prefs'), { recursive: true });
    await fs.writeFile(prefsFile(key), '{ not json ', 'utf-8');
    expect(await readTablePrefs(key)).toBeNull();
  });

  it('未知 version → null 不 throw', async () => {
    const { readTablePrefs } = await import('../../electron/main/fs/tablePrefs');
    const key = '/project/future.csv';
    await fs.mkdir(join(PATHS_ORU_DIR, 'users', OWNER, 'table-prefs'), { recursive: true });
    await fs.writeFile(prefsFile(key), JSON.stringify({ version: 99, rowHeightPx: 999 }), 'utf-8');
    expect(await readTablePrefs(key)).toBeNull();
  });

  it('relocate 后旧 key 读 null、新 key 读到原值', async () => {
    const { readTablePrefs, writeTablePrefs, relocateTablePrefs } = await import(
      '../../electron/main/fs/tablePrefs'
    );
    const oldKey = '/project/old.csv';
    const newKey = '/project/moved.csv';
    await writeTablePrefs(oldKey, { columnWidths: [200], rowHeightPx: 48 });
    await relocateTablePrefs(oldKey, newKey);
    expect(await readTablePrefs(oldKey)).toBeNull();
    expect(await readTablePrefs(newKey)).toEqual({ columnWidths: [200], rowHeightPx: 48 });
  });

  it('relocate 源不存在 → 静默无事，新 key 仍无偏好', async () => {
    const { readTablePrefs, relocateTablePrefs } = await import('../../electron/main/fs/tablePrefs');
    await relocateTablePrefs('/project/ghost.csv', '/project/dest.csv');
    expect(await readTablePrefs('/project/dest.csv')).toBeNull();
  });
});
