import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renameEntry,
  moveEntry,
  duplicateEntry,
  trashEntry,
  setAssetsRenameImplForTest,
} from '../../electron/main/fs/mutate';
import { setTrashItemImplForTest } from '../../electron/main/fs/trash';
import { runExclusive } from '../../electron/main/fs/runExclusive';
import { rename as fsRename } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * renameEntry 的 `.md` + `.assets` 联动（§九/§十一）：改名要原子做「改文档名 + 改 assets 名 + 回写引用」，
 * 回写后的新内容随结果回传（供 relocate 重置编辑器内存态，挡住 pending autosave 盖回写）。
 */
let root: string;

function seedDoc(): void {
  // 架构.md 引用自己的 架构.assets/图.png
  writeFileSync(join(root, '架构.md'), '# 架构\n![图](架构.assets/图.png)\n');
  mkdirSync(join(root, '架构.assets'), { recursive: true });
  writeFileSync(join(root, '架构.assets', '图.png'), Buffer.from([1, 2, 3]));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-mutassets-'));
  setAssetsRenameImplForTest(fsRename); // 默认真 rename
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  setAssetsRenameImplForTest(fsRename);
});

describe('renameEntry · .md + .assets 联动', () => {
  it('改名同时改 assets 名、回写引用、回传新内容', async () => {
    seedDoc();

    const r = await renameEntry(root, '架构.md', '方案.md');

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.path).toBe('方案.md');
    // 文档落到新名，内容引用已回写
    expect(existsSync(join(root, '架构.md'))).toBe(false);
    expect(readFileSync(join(root, '方案.md'), 'utf-8')).toContain('![图](方案.assets/图.png)');
    // assets 文件夹连同图片一起改名
    expect(existsSync(join(root, '架构.assets'))).toBe(false);
    expect(readFileSync(join(root, '方案.assets', '图.png'))).toEqual(Buffer.from([1, 2, 3]));
    // 回传回写后的新内容（relocate 用它重置内存态）
    expect(r.content).toContain('方案.assets/图.png');
  });

  it('无 .assets 的 .md：退化为普通改名，不回传 content', async () => {
    writeFileSync(join(root, '随笔.md'), '# 随笔\n没有图');

    const r = await renameEntry(root, '随笔.md', '日记.md');

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.content).toBeUndefined();
    expect(readFileSync(join(root, '日记.md'), 'utf-8')).toBe('# 随笔\n没有图');
  });

  it('撞名：目标 .md 已存在 → conflict，源原封不动', async () => {
    seedDoc();
    writeFileSync(join(root, '方案.md'), '占位');

    const r = await renameEntry(root, '架构.md', '方案.md');

    expect(r.status).toBe('conflict');
    expect(existsSync(join(root, '架构.md'))).toBe(true);
    expect(existsSync(join(root, '架构.assets'))).toBe(true);
    expect(readFileSync(join(root, '方案.md'), 'utf-8')).toBe('占位'); // 不被覆盖
  });

  it('撞名：目标 .assets 已存在 → conflict，源原封不动', async () => {
    seedDoc();
    mkdirSync(join(root, '方案.assets'), { recursive: true });

    const r = await renameEntry(root, '架构.md', '方案.md');

    expect(r.status).toBe('conflict');
    expect(existsSync(join(root, '架构.md'))).toBe(true);
    expect(existsSync(join(root, '方案.md'))).toBe(false);
  });

  it('回滚：新 .md 写成功、.assets rename 失败 → 回滚新 .md、源保留、返回 incomplete（非假 ok）', async () => {
    seedDoc();
    setAssetsRenameImplForTest(async () => {
      throw new Error('注入：assets rename 失败');
    });

    const r = await renameEntry(root, '架构.md', '方案.md');

    expect(r.status).toBe('incomplete');
    // 新 .md 被回滚删掉
    expect(existsSync(join(root, '方案.md'))).toBe(false);
    // 源 .md 与源 assets 仍在（用户内容不丢）
    expect(existsSync(join(root, '架构.md'))).toBe(true);
    expect(existsSync(join(root, '架构.assets', '图.png'))).toBe(true);
  });
});

describe('moveEntry · .md + .assets 联动', () => {
  it('移动 .md 时同名 .assets 一并移到目标目录，相对引用不变、图仍指得到', async () => {
    seedDoc();
    mkdirSync(join(root, 'sub'), { recursive: true });

    const r = await moveEntry(root, '架构.md', 'sub');

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.path).toBe('sub/架构.md');
    expect(existsSync(join(root, '架构.md'))).toBe(false);
    expect(existsSync(join(root, '架构.assets'))).toBe(false);
    // .assets 跟着搬到 sub/，图片在；引用是相对路径，内容不动
    expect(existsSync(join(root, 'sub', '架构.assets', '图.png'))).toBe(true);
    expect(readFileSync(join(root, 'sub', '架构.md'), 'utf-8')).toContain('架构.assets/图.png');
  });

  it('撞名：目标目录已有同名 .assets → conflict，源不动', async () => {
    seedDoc();
    mkdirSync(join(root, 'sub', '架构.assets'), { recursive: true });

    const r = await moveEntry(root, '架构.md', 'sub');

    expect(r.status).toBe('conflict');
    expect(existsSync(join(root, '架构.md'))).toBe(true);
    expect(existsSync(join(root, '架构.assets'))).toBe(true);
  });
});

describe('duplicateEntry · .md + .assets 联动', () => {
  it('副本带独立 .assets、引用指向自己（不与原共享）', async () => {
    seedDoc();

    const r = await duplicateEntry(root, '架构.md', '副本');

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.path).toBe('架构 副本.md');
    // 副本的 assets 独立存在、含图
    expect(existsSync(join(root, '架构 副本.assets', '图.png'))).toBe(true);
    // 副本内引用指向「副本自己的 assets」
    expect(readFileSync(join(root, '架构 副本.md'), 'utf-8')).toContain('架构 副本.assets/图.png');
    // 原文档与原 assets 分毫不动
    expect(readFileSync(join(root, '架构.md'), 'utf-8')).toContain('架构.assets/图.png');
    expect(existsSync(join(root, '架构.assets', '图.png'))).toBe(true);
  });

  // 英文后缀走同一条 .md+.assets 路径：副本名与内部 assets 引用都用注入的后缀词。
  it('英文后缀 → 副本名「base copy.md」、assets 与回写引用同用 copy', async () => {
    seedDoc();

    const r = await duplicateEntry(root, '架构.md', 'copy');

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.path).toBe('架构 copy.md');
    expect(existsSync(join(root, '架构 copy.assets', '图.png'))).toBe(true);
    expect(readFileSync(join(root, '架构 copy.md'), 'utf-8')).toContain('架构 copy.assets/图.png');
  });
});

describe('改名回写与实时保存并发（§十一 C-2：同一把 workfile 锁互斥）', () => {
  it('改名联动改名走的锁 key = resolve(旧 .md)，与 commitWorkfileWrite 同锁 → 严格互斥不交错', async () => {
    seedDoc();
    const order: string[] = [];
    const lockKey = resolve(join(root, '架构.md'));

    // 先占住 workfile 锁并停留一会儿（模拟实时保存的临界区在跑）
    const holder = runExclusive(lockKey, async () => {
      order.push('save-in');
      await new Promise((r) => setTimeout(r, 50));
      order.push('save-out');
    });
    // 紧接着发起改名：若改名进的是同一把锁，必须等实时保存临界区退出后才能跑
    const renamed = renameEntry(root, '架构.md', '方案.md').then((r) => {
      order.push('rename-done');
      return r;
    });

    const [, r] = await Promise.all([holder, renamed]);
    // 严格顺序：save 临界区完整跑完（in→out）后改名才完成——证明同锁、无中间态穿插
    expect(order).toEqual(['save-in', 'save-out', 'rename-done']);
    expect(r.status).toBe('ok');
  });
});

describe('move/trash 无 .assets 的 .md 也进 workfile 锁（§十一 C-2：防实时保存重建已移走/删除的文件）', () => {
  it('move 无 .assets 的打开态 .md：与实时保存临界区严格互斥', async () => {
    writeFileSync(join(root, '草稿.md'), '内容'); // 无 .assets
    mkdirSync(join(root, 'archive'), { recursive: true });
    const order: string[] = [];
    const holder = runExclusive(resolve(join(root, '草稿.md')), async () => {
      order.push('save-in');
      await new Promise((r) => setTimeout(r, 50));
      order.push('save-out');
    });
    const moved = moveEntry(root, '草稿.md', 'archive').then((r) => {
      order.push('move-done');
      return r;
    });
    const [, r] = await Promise.all([holder, moved]);
    expect(order).toEqual(['save-in', 'save-out', 'move-done']);
    expect(r.status).toBe('ok');
  });

  it('trash 无 .assets 的打开态 .md：与实时保存临界区严格互斥', async () => {
    writeFileSync(join(root, '草稿.md'), '内容');
    setTrashItemImplForTest(async () => {});
    const order: string[] = [];
    const holder = runExclusive(resolve(join(root, '草稿.md')), async () => {
      order.push('save-in');
      await new Promise((r) => setTimeout(r, 50));
      order.push('save-out');
    });
    const trashed = trashEntry(root, '草稿.md').then((r) => {
      order.push('trash-done');
      return r;
    });
    const [, r] = await Promise.all([holder, trashed]);
    expect(order).toEqual(['save-in', 'save-out', 'trash-done']);
    expect(r.status).toBe('ok');
  });
});

describe('trashEntry · .md + .assets 联动', () => {
  it('删 .md 时同名 .assets 一并进回收站', async () => {
    seedDoc();
    const trashed: string[] = [];
    setTrashItemImplForTest(async (p) => {
      trashed.push(p);
    });

    const r = await trashEntry(root, '架构.md');

    expect(r.status).toBe('ok');
    expect(trashed.some((p) => p.endsWith('架构.md'))).toBe(true);
    expect(trashed.some((p) => p.endsWith('架构.assets'))).toBe(true);
  });

  it('回滚：第二步 trash 失败 → 返回 incomplete（非裸抛、非假 ok）', async () => {
    seedDoc();
    let calls = 0;
    setTrashItemImplForTest(async () => {
      calls++;
      if (calls === 2) throw new Error('注入：第二个 trash 失败');
    });

    const r = await trashEntry(root, '架构.md');

    expect(r.status).toBe('incomplete');
  });
});
