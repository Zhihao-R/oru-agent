/**
 * safeWriteAsync 内核单测——与同步版 safeWrite 同语义的异步原子写：
 *  - 内容落盘正确 + 自动 mkdir -p
 *  - 写完无 tmp 残留（tmp+rename 不留中间态）
 *  - CRLF 模式换行转换（含 content 自带 \r\n 不变 \r\r\n）
 *  - 覆盖既有文件保留权限位
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeWriteAsync } from '../../electron/main/fs/safeWrite';

const DIR = join(tmpdir(), `oru-test-safewrite-async-${Date.now()}`);

describe('safeWriteAsync', () => {
  beforeAll(async () => {
    await fs.mkdir(DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(DIR, { recursive: true, force: true });
  });

  it('写入内容正确，且自动创建缺失的中间目录', async () => {
    const p = join(DIR, 'deep/nested/file.html');
    await safeWriteAsync(p, '<html>你好</html>');
    expect(await fs.readFile(p, 'utf-8')).toBe('<html>你好</html>');
  });

  it('写完无 tmp 残留', async () => {
    const p = join(DIR, 'no-tmp.json');
    await safeWriteAsync(p, '{"a":1}');
    const files = await fs.readdir(DIR);
    expect(files.filter((f) => f.includes('.tmp.'))).toEqual([]);
  });

  it('CRLF 模式：LF 内容转 CRLF，自带 CRLF 不变 \\r\\r\\n', async () => {
    const p = join(DIR, 'crlf.txt');
    await safeWriteAsync(p, 'a\nb\r\nc\n', 'CRLF');
    expect(await fs.readFile(p, 'utf-8')).toBe('a\r\nb\r\nc\r\n');
  });

  it('覆盖既有文件时保留原权限位', async () => {
    const p = join(DIR, 'mode.txt');
    await fs.writeFile(p, 'old', { mode: 0o600 });
    await fs.chmod(p, 0o600);
    await safeWriteAsync(p, 'new');
    const mode = (await fs.stat(p)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await fs.readFile(p, 'utf-8')).toBe('new');
  });
});
