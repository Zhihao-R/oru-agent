import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDir, createFile } from '../../electron/main/fs/createFile';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-createfile-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createFile · 无覆盖原子建文件', () => {
  it('目标不存在 → ok，内容如实落盘', async () => {
    const r = await createFile(root, 'a.md', 'hello');
    expect(r.status).toBe('ok');
    expect(readFileSync(join(root, 'a.md'), 'utf-8')).toBe('hello');
  });

  it('目标已存在 → conflict，老文件字节分毫不动', async () => {
    writeFileSync(join(root, 'a.md'), 'old');
    const r = await createFile(root, 'a.md', 'new');
    expect(r.status).toBe('conflict');
    expect(readFileSync(join(root, 'a.md'), 'utf-8')).toBe('old');
  });

  it('两次几乎同时建同名 → 只有一个 ok，另一个 conflict，落盘是先到者', async () => {
    const [r1, r2] = await Promise.all([
      createFile(root, 'race.csv', 'first'),
      createFile(root, 'race.csv', 'second'),
    ]);
    const oks = [r1, r2].filter((r) => r.status === 'ok');
    const conflicts = [r1, r2].filter((r) => r.status === 'conflict');
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    // 落盘内容必是某一个完整值，绝非两次写交错的半成品
    expect(['first', 'second']).toContain(readFileSync(join(root, 'race.csv'), 'utf-8'));
  });

  it('扩展名白名单：.md / .csv 放行，.html 等 → invalid 且不落盘', async () => {
    expect((await createFile(root, 'a.md', '')).status).toBe('ok');
    expect((await createFile(root, 'b.csv', '')).status).toBe('ok');
    const bad = await createFile(root, 'evil.html', '<script>');
    expect(bad.status).toBe('invalid');
    expect(() => readFileSync(join(root, 'evil.html'))).toThrow();
  });

  it('父目录不存在时自动补齐（mkdir -p）', async () => {
    const r = await createFile(root, 'deep/nested/note.md', 'x');
    expect(r.status).toBe('ok');
    expect(readFileSync(join(root, 'deep/nested/note.md'), 'utf-8')).toBe('x');
  });

  it('路径穿越项目根 → 抛错，不落盘到项目外', async () => {
    await expect(createFile(root, '../escape.md', 'pwned')).rejects.toThrow(/escape/);
  });
});

describe('createDir · 建空目录（非 recursive）', () => {
  it('目标不存在 → ok，目录真实存在', async () => {
    const r = await createDir(root, 'docs');
    expect(r.status).toBe('ok');
    // 目录无法 readFile——往里建子文件验证它真实可写
    writeFileSync(join(root, 'docs/x.txt'), '1');
    expect(readFileSync(join(root, 'docs/x.txt'), 'utf-8')).toBe('1');
  });

  it('目标目录已存在 → conflict（非 recursive，不被静默吞）', async () => {
    mkdirSync(join(root, 'docs'));
    const r = await createDir(root, 'docs');
    expect(r.status).toBe('conflict');
  });

  it('与已有文件同名 → conflict，老文件不动', async () => {
    writeFileSync(join(root, 'docs'), 'iam a file');
    const r = await createDir(root, 'docs');
    expect(r.status).toBe('conflict');
    expect(readFileSync(join(root, 'docs'), 'utf-8')).toBe('iam a file');
  });

  it('两次几乎同时建同名目录 → 只有一个 ok', async () => {
    const [r1, r2] = await Promise.all([createDir(root, 'd'), createDir(root, 'd')]);
    expect([r1, r2].filter((r) => r.status === 'ok')).toHaveLength(1);
    expect([r1, r2].filter((r) => r.status === 'conflict')).toHaveLength(1);
  });
});
