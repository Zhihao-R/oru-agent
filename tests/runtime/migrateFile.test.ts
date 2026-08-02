/**
 * 迁移前原样副本 + 读时迁移的文件级组合（理想架构 S06 · G129）——
 * data-durability「迁移前留原样副本」：迁移程序也是程序、也会有 bug，而它改写的是唯一一份
 * 身份数据；动手改写之前旧格式先原样复制一份，最坏情形从「数据没了」降为「这次升级白做」。
 *
 * preMigrationBackup：写 <file>.pre-v<N>.bak（原字节）；已存在不覆盖（最早那份才是原样）。
 * migrateFileOnRead：parse + 需要迁移时先落副本 + migrateOnRead 升级——adopter 一个调用点全包。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preMigrationBackup, migrateFileOnRead } from '../../electron/main/runtime/migrateFile';
import type { Migration } from '../../electron/main/runtime/migrateOnRead';

const DIR = join(tmpdir(), `oru-test-migrate-file-${Date.now()}`);

beforeAll(async () => {
  await fs.mkdir(DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

/** v1（裸对象）→ v2 envelope 的最小迁移链。 */
const CHAIN: ReadonlyArray<Migration> = [(prev) => ({ version: 2, data: prev })];

describe('preMigrationBackup', () => {
  it('写 <file>.pre-v<N>.bak，内容是原样字节', async () => {
    const f = join(DIR, 'a.json');
    const rawText = '{"name":"原样字节，含尾随空格 "}  ';
    await fs.writeFile(f, rawText);
    await preMigrationBackup(f, rawText, 1);
    expect(await fs.readFile(`${f}.pre-v1.bak`, 'utf-8')).toBe(rawText);
  });

  it('副本已存在 → 不覆盖（最早那份才是迁移前原样）', async () => {
    const f = join(DIR, 'b.json');
    await preMigrationBackup(f, '第一份', 1);
    await preMigrationBackup(f, '第二份（不该写入）', 1);
    expect(await fs.readFile(`${f}.pre-v1.bak`, 'utf-8')).toBe('第一份');
  });
});

describe('migrateFileOnRead', () => {
  it('老格式（低于当前版本）→ 先落原样副本，再返回迁移后的最新形态', async () => {
    const f = join(DIR, 'c.json');
    const rawText = '{"name":"老数据"}';
    await fs.writeFile(f, rawText);
    const out = await migrateFileOnRead<{ version: number; data: { name: string } }>(f, rawText, CHAIN, 1);
    expect(out).toEqual({ version: 2, data: { name: '老数据' } });
    expect(await fs.readFile(`${f}.pre-v1.bak`, 'utf-8')).toBe(rawText);
  });

  it('已是当前版本 → 不落副本、原样返回', async () => {
    const f = join(DIR, 'd.json');
    const rawText = '{"version":2,"data":{"name":"新数据"}}';
    await fs.writeFile(f, rawText);
    const out = await migrateFileOnRead<{ version: number }>(f, rawText, CHAIN, 1);
    expect(out.version).toBe(2);
    await expect(fs.access(`${f}.pre-v2.bak`)).rejects.toThrow();
    await expect(fs.access(`${f}.pre-v1.bak`)).rejects.toThrow();
  });

  it('未来版本（高于当前）→ 原样返回不迁移、不落副本（是否拒绝由 adopter 定）', async () => {
    const f = join(DIR, 'e.json');
    const rawText = '{"version":9,"data":{}}';
    const out = await migrateFileOnRead<{ version: number }>(f, rawText, CHAIN, 1);
    expect(out.version).toBe(9);
    const entries = await fs.readdir(DIR);
    expect(entries.filter((n) => n.startsWith('e.json.pre-'))).toEqual([]);
  });

  it('version 字段非法 → 抛（SchemaMigrationError 语义），不落副本', async () => {
    const f = join(DIR, 'f.json');
    await expect(migrateFileOnRead(f, '{"version":"2"}', CHAIN, 1)).rejects.toThrow();
    const entries = await fs.readdir(DIR);
    expect(entries.filter((n) => n.startsWith('f.json.pre-'))).toEqual([]);
  });

  it('JSON 半写坏 → 抛给调用方（损坏处置是 adopter 的既有路径）', async () => {
    await expect(migrateFileOnRead(join(DIR, 'g.json'), '{"ver', CHAIN, 1)).rejects.toThrow();
  });
});
