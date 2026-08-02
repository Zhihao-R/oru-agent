/**
 * globSearch 两档降级单测——精确 glob 命中即返回（fuzzy=false，零噪音）；精确零命中则把
 * pattern 实义字符当子序列模糊匹配 basename（fuzzy=true），按接近度排序。覆盖两档切换、
 * 排序、大小写、中文、纯通配符空返回等易被静默吞掉的边界。
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { globSearch } from '../../electron/main/fs/search';

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function touch(rel: string, mtimeSec?: number): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, '', 'utf-8');
  if (mtimeSec !== undefined) utimesSync(full, mtimeSec, mtimeSec);
}

describe('globSearch 精确档', () => {
  it('精确 glob 命中 → fuzzy=false，只回匹配文件', () => {
    root = mkdtempSync(join(tmpdir(), 'glob-'));
    touch('a.ts');
    touch('b.md');
    const r = globSearch('*.ts', root, 50);
    expect(r.fuzzy).toBe(false);
    expect(r.files).toEqual(['a.ts']);
  });

  it('精确命中按 mtime 倒序（最近改的在前）', () => {
    root = mkdtempSync(join(tmpdir(), 'glob-'));
    touch('old.ts', 1000);
    touch('new.ts', 9000);
    const r = globSearch('*.ts', root, 50);
    expect(r.fuzzy).toBe(false);
    expect(r.files).toEqual(['new.ts', 'old.ts']);
  });

  it('超过 limit → truncated=true', () => {
    root = mkdtempSync(join(tmpdir(), 'glob-'));
    for (let i = 0; i < 5; i++) touch(`f${i}.ts`);
    const r = globSearch('*.ts', root, 3);
    expect(r.truncated).toBe(true);
    expect(r.files).toHaveLength(3);
  });
});

describe('globSearch 模糊降级档', () => {
  it('精确零命中 → 子序列模糊兜底，fuzzy=true', () => {
    root = mkdtempSync(join(tmpdir(), 'glob-'));
    touch('deck-export.ts');
    touch('unrelated.md');
    const r = globSearch('dck', root, 50); // 无 * 通配、精确零命中 → 降级
    expect(r.fuzzy).toBe(true);
    expect(r.files).toContain('deck-export.ts'); // d-c-k 是 deck-export 的子序列
    expect(r.files).not.toContain('unrelated.md');
  });

  it('模糊结果按接近度排序（子序列跨度越紧凑越前）', () => {
    root = mkdtempSync(join(tmpdir(), 'glob-'));
    touch('abc.ts'); // a,b,c 挨着 → 跨度最小
    touch('a-x-b-x-c.ts'); // a..b..c 跨度大
    const r = globSearch('abc', root, 50);
    expect(r.fuzzy).toBe(true);
    expect(r.files[0]).toBe('abc.ts');
  });

  it('模糊匹配大小写不敏感', () => {
    root = mkdtempSync(join(tmpdir(), 'glob-'));
    touch('ReadMe.txt');
    const r = globSearch('rdm', root, 50);
    expect(r.fuzzy).toBe(true);
    expect(r.files).toContain('ReadMe.txt');
  });

  it('中文 basename 也能模糊命中', () => {
    root = mkdtempSync(join(tmpdir(), 'glob-'));
    touch('季度报销流程.md');
    const r = globSearch('报销', root, 50);
    expect(r.fuzzy).toBe(true);
    expect(r.files).toContain('季度报销流程.md');
  });

  it('纯通配符（实义字符为空）无从模糊 → 空结果', () => {
    root = mkdtempSync(join(tmpdir(), 'glob-'));
    touch('a.ts');
    const r = globSearch('*/**', root, 50); // 精确零命中，去掉元字符后 needle 为空
    expect(r.fuzzy).toBe(true);
    expect(r.files).toEqual([]);
  });
});
