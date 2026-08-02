import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renameEntry, duplicateEntry, moveEntry, trashEntry } from '../../electron/main/fs/mutate';
import { setTrashItemImplForTest } from '../../electron/main/fs/trash';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-mutate-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('renameEntry · 重命名', () => {
  it('文件改名 → ok，新名存在、旧名消失、内容保留', async () => {
    writeFileSync(join(root, 'a.md'), 'hello');
    const r = await renameEntry(root, 'a.md', 'b.md');
    expect(r).toEqual({ status: 'ok', path: 'b.md' });
    expect(existsSync(join(root, 'a.md'))).toBe(false);
    expect(readFileSync(join(root, 'b.md'), 'utf-8')).toBe('hello');
  });

  it('文件夹改名 → ok，整棵子树跟着走', async () => {
    mkdirSync(join(root, 'old/sub'), { recursive: true });
    writeFileSync(join(root, 'old/sub/x.md'), 'deep');
    const r = await renameEntry(root, 'old', 'new');
    expect(r.status).toBe('ok');
    expect(readFileSync(join(root, 'new/sub/x.md'), 'utf-8')).toBe('deep');
    expect(existsSync(join(root, 'old'))).toBe(false);
  });

  it('新名撞同目录已有文件 → conflict，两边都分毫不动', async () => {
    writeFileSync(join(root, 'a.md'), 'aaa');
    writeFileSync(join(root, 'b.md'), 'bbb');
    const r = await renameEntry(root, 'a.md', 'b.md');
    expect(r.status).toBe('conflict');
    expect(readFileSync(join(root, 'a.md'), 'utf-8')).toBe('aaa');
    expect(readFileSync(join(root, 'b.md'), 'utf-8')).toBe('bbb');
  });

  it('新名含路径分隔符（/ 或 :）→ invalid，不动盘', async () => {
    writeFileSync(join(root, 'a.md'), 'x');
    expect((await renameEntry(root, 'a.md', 'sub/b.md')).status).toBe('invalid');
    expect((await renameEntry(root, 'a.md', 'b:c.md')).status).toBe('invalid');
    expect(existsSync(join(root, 'a.md'))).toBe(true);
  });

  it('源不存在 → not-found', async () => {
    const r = await renameEntry(root, 'ghost.md', 'x.md');
    expect(r.status).toBe('not-found');
  });

  it('源路径穿越项目根 → 抛错', async () => {
    await expect(renameEntry(root, '../escape.md', 'x.md')).rejects.toThrow(/escape/);
  });
});

describe('duplicateEntry · 生成副本', () => {
  it('文件 → ok，副本名「基础名 副本.ext」，内容相同、原件还在', async () => {
    writeFileSync(join(root, 'plan.md'), 'body');
    const r = await duplicateEntry(root, 'plan.md', '副本');
    expect(r).toEqual({ status: 'ok', path: 'plan 副本.md' });
    expect(readFileSync(join(root, 'plan.md'), 'utf-8')).toBe('body');
    expect(readFileSync(join(root, 'plan 副本.md'), 'utf-8')).toBe('body');
  });

  it('副本名已存在 → 加序号「基础名 副本 2.ext」', async () => {
    writeFileSync(join(root, 'plan.md'), 'a');
    writeFileSync(join(root, 'plan 副本.md'), 'b');
    const r = await duplicateEntry(root, 'plan.md', '副本');
    expect(r).toEqual({ status: 'ok', path: 'plan 副本 2.md' });
    expect(readFileSync(join(root, 'plan 副本 2.md'), 'utf-8')).toBe('a');
  });

  // PT-006：后缀词由调用方按 owner 语言注入——英文 owner 得「plan copy.md」/「plan copy 2.md」。
  it('英文后缀 → 副本名「base copy.ext」，撞名「base copy 2.ext」', async () => {
    writeFileSync(join(root, 'plan.md'), 'a');
    const r1 = await duplicateEntry(root, 'plan.md', 'copy');
    expect(r1).toEqual({ status: 'ok', path: 'plan copy.md' });
    const r2 = await duplicateEntry(root, 'plan.md', 'copy');
    expect(r2).toEqual({ status: 'ok', path: 'plan copy 2.md' });
  });

  it('文件夹 → ok，整棵子树一起复制，原件不动', async () => {
    mkdirSync(join(root, 'deck/sub'), { recursive: true });
    writeFileSync(join(root, 'deck/sub/x.html'), 'page');
    const r = await duplicateEntry(root, 'deck', '副本');
    expect(r).toEqual({ status: 'ok', path: 'deck 副本' });
    expect(readFileSync(join(root, 'deck 副本/sub/x.html'), 'utf-8')).toBe('page');
    expect(readFileSync(join(root, 'deck/sub/x.html'), 'utf-8')).toBe('page');
  });

  it('源不存在 → not-found', async () => {
    expect((await duplicateEntry(root, 'ghost.md', '副本')).status).toBe('not-found');
  });

  it('源路径穿越项目根 → 抛错', async () => {
    await expect(duplicateEntry(root, '../escape.md', '副本')).rejects.toThrow(/escape/);
  });
});

describe('moveEntry · 移到目标文件夹', () => {
  it('文件移进子文件夹 → ok，出现在目标、原位消失', async () => {
    writeFileSync(join(root, 'a.md'), 'x');
    mkdirSync(join(root, 'docs'));
    const r = await moveEntry(root, 'a.md', 'docs');
    expect(r).toEqual({ status: 'ok', path: 'docs/a.md' });
    expect(existsSync(join(root, 'a.md'))).toBe(false);
    expect(readFileSync(join(root, 'docs/a.md'), 'utf-8')).toBe('x');
  });

  it('目标已有同名 → conflict，源留原处、目标不动', async () => {
    writeFileSync(join(root, 'a.md'), 'src');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/a.md'), 'dst');
    const r = await moveEntry(root, 'a.md', 'docs');
    expect(r.status).toBe('conflict');
    expect(readFileSync(join(root, 'a.md'), 'utf-8')).toBe('src');
    expect(readFileSync(join(root, 'docs/a.md'), 'utf-8')).toBe('dst');
  });

  it('把文件夹移进它自己 → invalid', async () => {
    mkdirSync(join(root, 'box'));
    expect((await moveEntry(root, 'box', 'box')).status).toBe('invalid');
  });

  it('把文件夹移进它的子目录（自吞）→ invalid', async () => {
    mkdirSync(join(root, 'box/inner'), { recursive: true });
    expect((await moveEntry(root, 'box', 'box/inner')).status).toBe('invalid');
  });

  it('原地移动（目标就是当前父目录）→ ok 且不动盘', async () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/a.md'), 'x');
    const before = readFileSync(join(root, 'docs/a.md'), 'utf-8');
    const r = await moveEntry(root, 'docs/a.md', 'docs');
    expect(r.status).toBe('ok');
    expect(readFileSync(join(root, 'docs/a.md'), 'utf-8')).toBe(before);
  });

  it('移到项目根（destDir=空）→ ok', async () => {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs/a.md'), 'x');
    const r = await moveEntry(root, 'docs/a.md', '');
    expect(r).toEqual({ status: 'ok', path: 'a.md' });
    expect(readFileSync(join(root, 'a.md'), 'utf-8')).toBe('x');
  });

  it('源不存在 → not-found', async () => {
    mkdirSync(join(root, 'docs'));
    expect((await moveEntry(root, 'ghost.md', 'docs')).status).toBe('not-found');
  });

  it('目标目录穿越项目根 → 抛错', async () => {
    writeFileSync(join(root, 'a.md'), 'x');
    await expect(moveEntry(root, 'a.md', '../outside')).rejects.toThrow(/escape/);
  });
});

describe('trashEntry · 删到回收站', () => {
  let trashed: string[];
  beforeEach(() => {
    trashed = [];
    setTrashItemImplForTest(async (p) => {
      trashed.push(p);
    });
  });

  it('删文件 → ok，绝对路径进回收站内核', async () => {
    writeFileSync(join(root, 'a.md'), 'x');
    const r = await trashEntry(root, 'a.md');
    expect(r.status).toBe('ok');
    expect(trashed).toEqual([join(root, 'a.md')]);
  });

  it('源不存在 → not-found，不调回收站', async () => {
    expect((await trashEntry(root, 'ghost.md')).status).toBe('not-found');
    expect(trashed).toEqual([]);
  });

  it('回收站抛错不降级永久删（原样抛、文件还在）', async () => {
    writeFileSync(join(root, 'a.md'), 'x');
    setTrashItemImplForTest(async () => {
      throw new Error('回收站不可用');
    });
    await expect(trashEntry(root, 'a.md')).rejects.toThrow(/回收站/);
    expect(existsSync(join(root, 'a.md'))).toBe(true);
  });
});
