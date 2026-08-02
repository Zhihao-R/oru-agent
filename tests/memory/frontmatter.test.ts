/**
 * Frontmatter helpers 单元测试
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ensureWithinRoot,
  parseFrontmatter,
  readMarkdownFile,
  stringifyFrontmatter,
  writeMarkdownFile,
} from '../../electron/main/fs/frontmatter';

describe('parseFrontmatter / stringifyFrontmatter', () => {
  it('解析含 frontmatter 的 markdown', () => {
    const text = `---
scope: personal
type: episode
tags:
  - 美食
  - 旅游
---

正文第一段。

正文第二段。
`;
    const { data, content } = parseFrontmatter(text);
    expect(data).toEqual({
      scope: 'personal',
      type: 'episode',
      tags: ['美食', '旅游'],
    });
    expect(content.trim()).toBe('正文第一段。\n\n正文第二段。');
  });

  it('解析无 frontmatter 的 markdown', () => {
    const { data, content } = parseFrontmatter('# 标题\n\n正文');
    expect(data).toEqual({});
    expect(content.trim()).toBe('# 标题\n\n正文');
  });

  it('stringify 后能 round-trip', () => {
    const original = { scope: 'agent', tags: ['a', 'b'] };
    const text = stringifyFrontmatter(original, '正文');
    const { data, content } = parseFrontmatter(text);
    expect(data).toEqual(original);
    expect(content.trim()).toBe('正文');
  });

  it('空 frontmatter 不写 ---', () => {
    expect(stringifyFrontmatter({}, '只有正文')).toBe('只有正文');
  });

  // 回归：正文若以 `---` 块开头，绝不能被当成 frontmatter 二次解析吞走（matter.stringify(裸字符串) 的坑）。
  it('正文以 --- 块开头：内容原样保留、不被吸进 frontmatter', () => {
    const body = '---\nname: 张三\nrole: 用户\n---\n真正的正文';
    const text = stringifyFrontmatter({ 'last-updated': '2026-06-29' }, body);
    const { data, content } = parseFrontmatter(text);
    expect(data).toEqual({ 'last-updated': '2026-06-29' }); // 只有系统字段，没把 name/role 吸进来
    expect(content).toContain('name: 张三'); // --- 块连同其内容仍在正文里
    expect(content).toContain('真正的正文');
  });
});

describe('readMarkdownFile / writeMarkdownFile', () => {
  it('读不存在的文件返回 null', async () => {
    const path = join(tmpdir(), `oru-test-${Date.now()}-notexist.md`);
    expect(await readMarkdownFile(path)).toBeNull();
  });

  it('写后读出来 frontmatter 一致', async () => {
    const path = join(tmpdir(), `oru-test-${Date.now()}-fm.md`);
    await writeMarkdownFile(path, { scope: 'personal', tags: ['x'] }, '内容');
    const f = await readMarkdownFile(path);
    expect(f).not.toBeNull();
    expect(f!.data).toEqual({ scope: 'personal', tags: ['x'] });
    expect(f!.content.trim()).toBe('内容');
    await fs.unlink(path);
  });

  // 回归：以 --- 开头的正文写盘后，必须能原样读回——既不丢内容、也不产生「再也 parse 不动」的坏档。
  it('正文以 --- 块开头：写盘后能完整读回（不吞、不毁档）', async () => {
    const path = join(tmpdir(), `oru-test-${Date.now()}-preamble.md`);
    // 正文「整段」以 --- 块开头（如 dream 删掉前言开场行后的残留）——旧实现会把它当 frontmatter 吸走
    const body = '---\n现居: 成都\n职业: 工程师\n---\n收尾。';
    await writeMarkdownFile(path, { 'last-updated': '2026-06-29' }, body);
    const f = await readMarkdownFile(path); // 不抛 YAMLException
    expect(f).not.toBeNull();
    expect(f!.data).toEqual({ 'last-updated': '2026-06-29' });
    expect(f!.content).toContain('现居: 成都'); // 分隔线下的内容没被吸走
    expect(f!.content).toContain('职业: 工程师');
    await fs.unlink(path);
  });

  it('父目录不存在时自动创建', async () => {
    const dir = join(tmpdir(), `oru-test-${Date.now()}-deep/a/b`);
    const path = join(dir, 'file.md');
    await writeMarkdownFile(path, { foo: 'bar' }, 'hi');
    const f = await readMarkdownFile(path);
    expect(f!.data).toEqual({ foo: 'bar' });
    await fs.rm(join(tmpdir(), `oru-test-${Date.now().toString().slice(0, 5)}-deep`), {
      recursive: true,
      force: true,
    }).catch(() => {});
  });
});

describe('ensureWithinRoot', () => {
  it('正常子路径 OK', () => {
    const abs = ensureWithinRoot('/tmp/root', 'sub/file.md');
    expect(abs).toBe('/tmp/root/sub/file.md');
  });

  it('绝对路径在 root 之下 OK', () => {
    const abs = ensureWithinRoot('/tmp/root', '/tmp/root/sub/file.md');
    expect(abs).toBe('/tmp/root/sub/file.md');
  });

  it('试图跳出 root 抛异常', () => {
    expect(() => ensureWithinRoot('/tmp/root', '../escape/file.md')).toThrow(/escapes/);
    expect(() => ensureWithinRoot('/tmp/root', '/etc/passwd')).toThrow(/escapes/);
  });
});
