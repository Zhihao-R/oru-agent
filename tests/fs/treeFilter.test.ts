/**
 * listDir 单测：
 * - HARD_FILTER（.narrative.md 不出现）
 * - 懒加载结构保证：只读一层、目录项不带 children → 不存在旧 buildTree 那种"全局预算跨层级误伤"
 * - 截断对用户可见：单目录超 MAX_ENTRIES_PER_DIR 截断并报 truncated 计数
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listDir } from '../../electron/main/fs/tree';

let tmpDir: string | null = null;

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('listDir', () => {
  it('HARD_FILTER：.narrative.md 不出现，index.html 出现', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oru-list-test-'));
    const deckDir = join(tmpDir, 'my-deck');
    await mkdir(deckDir);
    await writeFile(join(deckDir, 'index.html'), '<html></html>', 'utf-8');
    await writeFile(join(deckDir, '.narrative.md'), '# 叙事文稿\n', 'utf-8');

    const { entries } = await listDir(tmpDir, 'my-deck');
    const names = entries.map((e) => e.name);
    expect(names).toContain('index.html');
    expect(names).not.toContain('.narrative.md');
  });

  it('只读一层：目录项不带 children，子目录体量不影响根层完整性（旧 buildTree 会漏后置兄弟）', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oru-list-test-'));
    // 一个"大"子目录（足够多的直接子项）+ 一个排在它后面的小目录
    const big = join(tmpDir, 'big');
    await mkdir(big);
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => writeFile(join(big, `f${i}.txt`), 'x', 'utf-8')),
    );
    await mkdir(join(tmpDir, 'zsmall')); // localeCompare 排在 big 之后

    const { entries } = await listDir(tmpDir, '');
    const names = entries.map((e) => e.name);
    // 根层必须同时含 big 和 zsmall —— 不会因 big 体量大而把 zsmall 挤掉
    expect(names).toContain('big');
    expect(names).toContain('zsmall');
    // 目录项是浅的：不递归、不带 children
    const bigNode = entries.find((e) => e.name === 'big');
    expect(bigNode?.isDirectory).toBe(true);
    expect((bigNode as { children?: unknown }).children).toBeUndefined();
  });

  it('单目录超上限：截断到 1000 项并报 truncated 计数', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oru-list-test-'));
    const flat = join(tmpDir, 'flat');
    await mkdir(flat);
    await Promise.all(
      Array.from({ length: 1100 }, (_, i) => writeFile(join(flat, `f${i}.txt`), 'x', 'utf-8')),
    );

    const { entries, truncated } = await listDir(tmpDir, 'flat');
    expect(entries.length).toBe(1000);
    expect(truncated).toBe(100);
  });
});
