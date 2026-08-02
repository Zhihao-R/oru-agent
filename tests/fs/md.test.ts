/**
 * fs/md.ts 路径沙箱（审计 N9：symlink 越界）
 *
 * 仅字符串 relative() 防不住项目内 symlink 指向项目外的目录——必须 realpath 二次校验。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMd, writeMd } from '../../electron/main/fs/md';

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await fs.mkdtemp(join(tmpdir(), 'oru-md-'));
  root = join(base, 'project');
  outside = join(base, 'outside');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
});
afterEach(async () => {
  await fs.rm(join(root, '..'), { recursive: true, force: true }).catch(() => {});
});

describe('fs/md 沙箱 (N9)', () => {
  it('正常项目内写读通', async () => {
    await writeMd(root, 'a.md', 'hello');
    expect(await readMd(root, 'a.md')).toBe('hello');
  });

  it('字符串 .. 越界被拒', async () => {
    await expect(writeMd(root, '../outside/evil.md', 'x')).rejects.toThrow(/escapes/);
  });

  it('经项目内 symlink 目录写到项目外被拒（realpath 二次校验）', async () => {
    // project/link -> outside（symlink 父目录）
    await fs.symlink(outside, join(root, 'link'), 'dir');
    // 字符串层 relative('project', 'project/link/evil.md') 不以 .. 开头 → 老实现放行
    await expect(writeMd(root, 'link/evil.md', 'pwned')).rejects.toThrow(/escapes/);
    // 确认没真写到外面
    const leaked = await fs
      .access(join(outside, 'evil.md'))
      .then(() => true)
      .catch(() => false);
    expect(leaked).toBe(false);
  });

  it('经项目内 symlink 读项目外文件被拒', async () => {
    await fs.writeFile(join(outside, 'secret.md'), 'secret', 'utf-8');
    await fs.symlink(outside, join(root, 'link'), 'dir');
    await expect(readMd(root, 'link/secret.md')).rejects.toThrow(/escapes/);
  });
});
