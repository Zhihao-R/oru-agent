/**
 * 记忆库格式版本哨（理想架构 S06 · G128）——data-durability「每类格式自带版本号」：
 * 记忆库是目录树（无单一 JSON 文件可挂 version 字段），版本落在 memory/format.json 哨文件。
 * 语义：记录「本程序按哪一代结构读写记忆库」（当前 v2 结构，见 memory/paths.ts 头注释）；
 * 是 G125 备份还原「按版本迁移」与未来结构演进的依据。
 * 铁律：高版本原样保留绝不写回降级（旧程序读到新库如实认账）；哨文件损坏则隔离重建（版本
 * 信息可再生——按当前程序版本重建，与「身份数据损坏必须保字节」不同类）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-memory-format-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'test-owner';
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => OWNER,
  LOCAL_USER_ID: OWNER,
}));

const memDir = join(ORU_DIR, 'users', OWNER, 'memory');
const formatFile = join(memDir, 'format.json');

beforeAll(async () => {
  await fs.mkdir(memDir, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('ensureMemoryFormatVersion', () => {
  it('哨文件不存在 → 建立 {version: 当前}，返回当前版本', async () => {
    const { ensureMemoryFormatVersion, MEMORY_FORMAT_VERSION } = await import(
      '../../electron/main/memory/formatVersion'
    );
    const v = await ensureMemoryFormatVersion(OWNER);
    expect(v).toBe(MEMORY_FORMAT_VERSION);
    expect(JSON.parse(await fs.readFile(formatFile, 'utf-8'))).toEqual({ version: MEMORY_FORMAT_VERSION });
  });

  it('已存在同版本 → 幂等，不改写文件', async () => {
    const { ensureMemoryFormatVersion } = await import('../../electron/main/memory/formatVersion');
    const before = await fs.stat(formatFile);
    await new Promise((r) => setTimeout(r, 10));
    await ensureMemoryFormatVersion(OWNER);
    const after = await fs.stat(formatFile);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('高版本（未来程序写的）→ 原样保留绝不写回降级，返回盘上版本', async () => {
    const { ensureMemoryFormatVersion, MEMORY_FORMAT_VERSION } = await import(
      '../../electron/main/memory/formatVersion'
    );
    const future = MEMORY_FORMAT_VERSION + 7;
    await fs.writeFile(formatFile, JSON.stringify({ version: future }));
    const v = await ensureMemoryFormatVersion(OWNER);
    expect(v).toBe(future);
    expect(JSON.parse(await fs.readFile(formatFile, 'utf-8'))).toEqual({ version: future });
  });

  it('读取 IO 错误（权限）→ 不隔离不改写（防把健康的高版本文件降级），按当前版本应答', async () => {
    const { ensureMemoryFormatVersion, MEMORY_FORMAT_VERSION } = await import(
      '../../electron/main/memory/formatVersion'
    );
    const future = MEMORY_FORMAT_VERSION + 3;
    await fs.writeFile(formatFile, JSON.stringify({ version: future }));
    await fs.chmod(formatFile, 0o000);
    try {
      const v = await ensureMemoryFormatVersion(OWNER);
      expect(v).toBe(MEMORY_FORMAT_VERSION); // 读不到只能按自身版本应答
    } finally {
      await fs.chmod(formatFile, 0o644);
    }
    // 文件原样、无隔离 sidecar 增量（IO 错误不是损坏）
    expect(JSON.parse(await fs.readFile(formatFile, 'utf-8'))).toEqual({ version: future });
  });

  it('哨文件损坏 → 隔离留痕后按当前版本重建（版本信息可再生，不算身份数据丢失）', async () => {
    const { ensureMemoryFormatVersion, MEMORY_FORMAT_VERSION } = await import(
      '../../electron/main/memory/formatVersion'
    );
    await fs.writeFile(formatFile, '{"version": "not-a-number"');
    const v = await ensureMemoryFormatVersion(OWNER);
    expect(v).toBe(MEMORY_FORMAT_VERSION);
    expect(JSON.parse(await fs.readFile(formatFile, 'utf-8'))).toEqual({ version: MEMORY_FORMAT_VERSION });
    // 损坏字节被隔离保留（sidecar），不是静默覆盖
    const entries = await fs.readdir(memDir);
    expect(entries.some((n) => n.startsWith('format.json.corrupt-'))).toBe(true);
  });
});
