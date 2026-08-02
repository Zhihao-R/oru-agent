/**
 * 换机还原（S07·G125）——manifest 校验、兜底备份、整目录重灌、密钥固化、往返复活。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const dir = join(tmpdir(), `oru-test-import-${Date.now()}`);
  process.env.ORU_DIR = dir;
  return dir;
});

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`CIPHER(${s})`, 'utf-8'),
    decryptString: (b: Buffer) => {
      const m = /^CIPHER\((.*)\)$/s.exec(b.toString('utf-8'));
      if (!m) throw new Error('not our cipher');
      return m[1];
    },
  },
}));

import { buildBackupZip } from '../../electron/main/backup/exportBackup';
import { restoreBackup, validateManifest, InvalidBackupError, isWithin } from '../../electron/main/backup/importBackup';
import { userDir, ORU_DIR as PATHS_ORU_DIR } from '../../electron/main/runtime/paths';

if (!PATHS_ORU_DIR.startsWith(tmpdir())) {
  throw new Error(`ORU_DIR 隔离失效（解析到 ${PATHS_ORU_DIR}）——拒绝在真实数据目录上跑测试`);
}

const OWNER = 'local-user';
const root = () => userDir(OWNER);

async function writeFile(rel: string, content: string): Promise<void> {
  const abs = join(root(), rel);
  await fs.mkdir(join(abs, '..'), { recursive: true });
  await fs.writeFile(abs, content);
}

beforeEach(async () => {
  await fs.mkdir(root(), { recursive: true });
});
afterEach(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('manifest 校验', () => {
  it('非本格式 / 版本过高抛 InvalidBackupError', () => {
    expect(() => validateManifest({ format: 'zip' })).toThrow(InvalidBackupError);
    expect(() => validateManifest(null)).toThrow(InvalidBackupError);
    expect(() => validateManifest({ format: 'oru-backup', version: 999 })).toThrow(InvalidBackupError);
    expect(validateManifest({ format: 'oru-backup', version: 1, exportedAt: 0, appVersion: 'x', includesKeys: false }).version).toBe(1);
  });
});

describe('还原往返', () => {
  it('还原前先兜底当前数据、再整目录重灌', async () => {
    // 造一份「当前」数据（会被还原覆盖，但应先被兜底备份）
    await writeFile('memory/personal/facts.md', '# 当前机器的旧数据');
    await writeFile('config.json', '{"settings":{"providers":[]}}');

    // 另造一份「备份包」：来自旧机、含不同数据
    await fs.rm(root(), { recursive: true, force: true });
    await fs.mkdir(root(), { recursive: true });
    await writeFile('memory/personal/facts.md', '# 备份里的记忆');
    await writeFile('conversations/twin/c1.jsonl', '{"role":"user","text":"你好"}');
    await writeFile('config.json', JSON.stringify({ settings: { providers: [{ id: 'p1', apiKey: 'sk-from-backup' }] } }));
    const backupBuf = await buildBackupZip({ includeKeys: true });
    const backupPath = join(ORU_DIR, 'backup.zip');
    await fs.writeFile(backupPath, backupBuf);

    // 把「当前」数据换回旧的，再执行还原
    await fs.rm(root(), { recursive: true, force: true });
    await writeFile('memory/personal/facts.md', '# 当前机器的旧数据');

    const { safetyBackupPath, manifest } = await restoreBackup(backupPath);

    expect(manifest.format).toBe('oru-backup');
    // 兜底备份已生成
    expect(existsSync(safetyBackupPath)).toBe(true);
    // 数据已被备份内容重灌
    expect(await fs.readFile(join(root(), 'memory/personal/facts.md'), 'utf-8')).toBe('# 备份里的记忆');
    expect(await fs.readFile(join(root(), 'conversations/twin/c1.jsonl'), 'utf-8')).toContain('你好');
  });

  it('含密钥备份还原后：config 里的 key 已加密固化（非明文落盘）', async () => {
    await writeFile('config.json', JSON.stringify({ settings: { providers: [{ id: 'p1', apiKey: 'sk-plain-in-backup' }] } }));
    const backupBuf = await buildBackupZip({ includeKeys: true });
    const backupPath = join(ORU_DIR, 'b.zip');
    await fs.writeFile(backupPath, backupBuf);

    await restoreBackup(backupPath);

    const restored = await fs.readFile(join(root(), 'config.json'), 'utf-8');
    expect(restored).not.toContain('sk-plain-in-backup'); // 已加密
    expect(restored).toContain('oru-enc:v1:');
  });

  it('Zip Slip 守卫：恶意条目名（含 ../）不逃出 owner 目录', async () => {
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true);
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b', '/a/b/../c')).toBe(false);
    expect(isWithin('/a/b', '/etc/passwd')).toBe(false);

    // 构造一个含逃逸条目的合法 manifest 备份包
    const JSZip = (await import('jszip')).default;
    const evil = new JSZip();
    evil.file('oru-backup.json', JSON.stringify({ format: 'oru-backup', version: 1, exportedAt: 0, appVersion: 'x', includesKeys: false }));
    evil.file('data/memory/ok.md', 'legit');
    evil.file('data/../../../../../../tmp/oru-zipslip-pwned.txt', 'pwned');
    const evilPath = join(ORU_DIR, 'evil.zip');
    await fs.writeFile(evilPath, await evil.generateAsync({ type: 'nodebuffer' }));

    await restoreBackup(evilPath);

    // 合法条目落地、逃逸条目被丢弃（未写到 /tmp）
    expect(await fs.readFile(join(root(), 'memory/ok.md'), 'utf-8')).toBe('legit');
    expect(existsSync('/tmp/oru-zipslip-pwned.txt')).toBe(false);
  });

  it('无效备份包（非 oru-backup）拒绝还原、不动当前数据', async () => {
    await writeFile('memory/keep.md', '别动我');
    const JSZip = (await import('jszip')).default;
    const bad = new JSZip();
    bad.file('random.txt', 'not a backup');
    const badPath = join(ORU_DIR, 'bad.zip');
    await fs.writeFile(badPath, await bad.generateAsync({ type: 'nodebuffer' }));

    await expect(restoreBackup(badPath)).rejects.toThrow(InvalidBackupError);
    // 当前数据未被动
    expect(await fs.readFile(join(root(), 'memory/keep.md'), 'utf-8')).toBe('别动我');
  });
});
