/**
 * textFile —— 表格保存链路的读写内核（.csv 白名单、自有尺寸策略、safeWriteAsync、
 * 写入带磁盘哈希前置校验防 TOCTOU）。不复用 writeMd：扩展名白名单 + 5MB 读上限 + 裸写三处都不合用。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { hashTextFile, readTextFile, writeTextFile } from '../../electron/main/fs/textFile';

let root: string;

const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf-8') : data).digest('hex');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-textfile-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readTextFile', () => {
  it('读取规范 UTF-8 CSV：content / encodingSafe / sha256', async () => {
    writeFileSync(join(root, 'a.csv'), '名,值\n张三,1\n');
    const r = await readTextFile(root, 'a.csv');
    expect(r.content).toBe('名,值\n张三,1\n');
    expect(r.encodingSafe).toBe(true);
    expect(r.encoding).toBe('utf-8');
    expect(r.sha256).toBe(sha256('名,值\n张三,1\n'));
  });

  it('GBK 文件：解码为中文，encodingSafe false', async () => {
    writeFileSync(join(root, 'g.csv'), iconv.encode('名,值\n张三,1\n', 'gbk'));
    const r = await readTextFile(root, 'g.csv');
    expect(r.content).toBe('名,值\n张三,1\n');
    expect(r.encodingSafe).toBe(false);
    expect(r.encoding).toBe('gbk');
  });

  it('UTF-8 但风格不规范（CRLF + 多余引号）：encodingSafe 仍为 true', async () => {
    // 承重用例：判据只问编码不问风格——编码转换不可逆才值得弹确认，风格重写无损、不该拦保存或导出
    writeFileSync(join(root, 's.csv'), '名,值\r\n"张三",1\r\n');
    const r = await readTextFile(root, 's.csv');
    expect(r.encodingSafe).toBe(true);
    expect(r.encoding).toBe('utf-8');
  });

  it('拒绝非 .csv 扩展', async () => {
    writeFileSync(join(root, 'a.md'), 'x');
    await expect(readTextFile(root, 'a.md')).rejects.toThrow(/csv/i);
  });

  it('拒绝越界路径', async () => {
    await expect(readTextFile(root, '../escape.csv')).rejects.toThrow();
  });

  it('不存在的文件报可读错误', async () => {
    await expect(readTextFile(root, 'none.csv')).rejects.toThrow();
  });

  it('超过尺寸上限拒读', async () => {
    writeFileSync(join(root, 'big.csv'), 'a,b\n1,2\n');
    await expect(readTextFile(root, 'big.csv', 4)).rejects.toThrow(/过大/);
  });
});

describe('writeTextFile', () => {
  it('无条件写：字节落盘、无 tmp 残留、返回新哈希', async () => {
    const r = await writeTextFile(root, 'out.csv', 'a,b\n1,2\n');
    expect(r.status).toBe('saved');
    expect(readFileSync(join(root, 'out.csv'), 'utf-8')).toBe('a,b\n1,2\n');
    expect(readdirSync(root).filter((f) => f.includes('.tmp.'))).toEqual([]);
    if (r.status === 'saved') expect(r.sha256).toBe(sha256('a,b\n1,2\n'));
  });

  it('expectedDiskSha256 匹配 → 写入；磁盘被外部改动 → conflict 且文件不动', async () => {
    writeFileSync(join(root, 'a.csv'), 'v1\n');
    const ok = await writeTextFile(root, 'a.csv', 'v2\n', sha256('v1\n'));
    expect(ok.status).toBe('saved');

    writeFileSync(join(root, 'a.csv'), '外部改动\n');
    const conflict = await writeTextFile(root, 'a.csv', 'v3\n', sha256('v2\n'));
    expect(conflict.status).toBe('conflict');
    expect(readFileSync(join(root, 'a.csv'), 'utf-8')).toBe('外部改动\n');
  });

  it('expected=null（期望文件不存在）：不存在→写入；已存在→conflict', async () => {
    const ok = await writeTextFile(root, 'new.csv', 'x\n', null);
    expect(ok.status).toBe('saved');
    const conflict = await writeTextFile(root, 'new.csv', 'y\n', null);
    expect(conflict.status).toBe('conflict');
  });

  it('拒绝非 .csv 扩展', async () => {
    await expect(writeTextFile(root, 'a.txt', 'x')).rejects.toThrow(/csv/i);
  });
});

describe('hashTextFile', () => {
  it('存在 → sha256+size；不存在 → sha256 null', async () => {
    writeFileSync(join(root, 'a.csv'), 'abc');
    const r = await hashTextFile(root, 'a.csv');
    expect(r.sha256).toBe(sha256('abc'));
    expect(r.size).toBe(3);
    const none = await hashTextFile(root, 'none.csv');
    expect(none.sha256).toBeNull();
  });
});
