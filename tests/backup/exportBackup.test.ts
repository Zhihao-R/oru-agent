/**
 * 整体导出（S07·G124）——黑名单排除、影子豁免变换、密钥勾选、整包往返。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';

// ⚠ 见 storeKeyEncryption.test.ts 同段注释：env 必须与 vi.mock 同相位（vi.hoisted）注入，
// 否则 paths.ts 会捕获真实 ~/.oru，buildBackupZip 会遍历/打包真实数据目录。
const ORU_DIR = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const dir = join(tmpdir(), `oru-test-export-${Date.now()}`);
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

import {
  buildBackupZip,
  isExcludedFromBackup,
  isConversationIndex,
  stripSdkSessionId,
  transformConfigForExport,
  BACKUP_MANIFEST_NAME,
  BACKUP_PAYLOAD_PREFIX,
  type BackupManifest,
} from '../../electron/main/backup/exportBackup';
import { userDir, ORU_DIR as PATHS_ORU_DIR } from '../../electron/main/runtime/paths';

// 硬护栏：解析根必须在 tmp，隔离失效即抛错拒跑（曾因此覆盖真实数据目录）。
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

describe('黑名单判据', () => {
  it('debug/ 与迁移副本与临时文件被排除，正常存储保留', () => {
    expect(isExcludedFromBackup('debug/2026-07-10/x.ndjson')).toBe(true);
    expect(isExcludedFromBackup('config.json.pre-v1.bak')).toBe(true);
    expect(isExcludedFromBackup('config.json.tmp.123.4')).toBe(true);
    expect(isExcludedFromBackup('config.json')).toBe(false);
    expect(isExcludedFromBackup('memory/personal/facts.md')).toBe(false);
    expect(isExcludedFromBackup('conversations/a1/c1.jsonl')).toBe(false);
  });
});

describe('影子豁免变换', () => {
  it('对话索引置空 sdkSessionId、保留其余字段', () => {
    expect(isConversationIndex('conversations/a1/index.json')).toBe(true);
    expect(isConversationIndex('conversations/a1/c1.jsonl')).toBe(false);
    const raw = JSON.stringify({
      version: 2,
      conversations: [{ id: 'c1', sdkSessionId: 'sess-abc', title: '你好' }],
    });
    const out = JSON.parse(stripSdkSessionId(raw));
    expect(out.conversations[0].sdkSessionId).toBeNull();
    expect(out.conversations[0].title).toBe('你好');
    expect(out.version).toBe(2);
  });

  it('config 不含密钥时清空全部密钥字段（含 webSearch）、含密钥时解密为明文', () => {
    const enc = (s: string) => 'oru-enc:v1:' + Buffer.from(`CIPHER(${s})`).toString('base64');
    const raw = JSON.stringify({
      settings: {
        providers: [{ id: 'p1', apiKey: enc('sk-real') }],
        manualApiKey: enc('sk-manual'),
        webSearch: { engines: [{ id: 'e1', apiKey: enc('sk-search') }] },
      },
    });
    const stripped = JSON.parse(transformConfigForExport(raw, false));
    expect(stripped.settings.providers[0].apiKey).toBe('');
    expect(stripped.settings.manualApiKey).toBe('');
    expect(stripped.settings.webSearch.engines[0].apiKey).toBe(''); // webSearch key 也脱敏（曾漏）
    const included = JSON.parse(transformConfigForExport(raw, true));
    expect(included.settings.providers[0].apiKey).toBe('sk-real');
    expect(included.settings.webSearch.engines[0].apiKey).toBe('sk-search');
  });

  it('config 解析失败：退回空 config、绝不原样带出（可能含明文）', () => {
    const out = JSON.parse(transformConfigForExport('{ 坏的 json', false));
    expect(out).toEqual({ settings: {} });
  });
});

describe('整包往返', () => {
  it('打包含 manifest、六类存储进 data/、排除影子、置空会话指针', async () => {
    await writeFile('memory/personal/facts.md', '# 事实');
    await writeFile('conversations/a1/c1.jsonl', '{"role":"user"}');
    await writeFile('conversations/a1/index.json', JSON.stringify({ conversations: [{ id: 'c1', sdkSessionId: 'sess-x' }] }));
    await writeFile('scheduled-tasks/s1.json', '{"version":2}');
    await writeFile('config.json', JSON.stringify({ settings: { providers: [{ id: 'p1', apiKey: 'oru-enc:v1:' + Buffer.from('CIPHER(sk-real)').toString('base64') }] } }));
    await writeFile('debug/2026/x.ndjson', 'log');
    await writeFile('config.json.pre-v1.bak', 'old');

    const buf = await buildBackupZip({ includeKeys: false });
    const zip = await JSZip.loadAsync(buf);

    const manifest = JSON.parse(await zip.file(BACKUP_MANIFEST_NAME)!.async('string')) as BackupManifest;
    expect(manifest.format).toBe('oru-backup');
    expect(manifest.appVersion).toBe('9.9.9');
    expect(manifest.includesKeys).toBe(false);

    // 六类存储进包
    expect(zip.file(BACKUP_PAYLOAD_PREFIX + 'memory/personal/facts.md')).toBeTruthy();
    expect(zip.file(BACKUP_PAYLOAD_PREFIX + 'conversations/a1/c1.jsonl')).toBeTruthy();
    expect(zip.file(BACKUP_PAYLOAD_PREFIX + 'scheduled-tasks/s1.json')).toBeTruthy();
    // 影子被排除
    expect(zip.file(BACKUP_PAYLOAD_PREFIX + 'debug/2026/x.ndjson')).toBeNull();
    expect(zip.file(BACKUP_PAYLOAD_PREFIX + 'config.json.pre-v1.bak')).toBeNull();
    // 会话指针置空
    const idx = JSON.parse(await zip.file(BACKUP_PAYLOAD_PREFIX + 'conversations/a1/index.json')!.async('string'));
    expect(idx.conversations[0].sdkSessionId).toBeNull();
    // 不含密钥：apiKey 清空
    const cfg = JSON.parse(await zip.file(BACKUP_PAYLOAD_PREFIX + 'config.json')!.async('string'));
    expect(cfg.settings.providers[0].apiKey).toBe('');
  });

  it('含密钥导出：manifest 标记 + apiKey 明文进包 + 独立密钥文件带走', async () => {
    await writeFile('config.json', JSON.stringify({ settings: { providers: [{ id: 'p1', apiKey: 'oru-enc:v1:' + Buffer.from('CIPHER(sk-real)').toString('base64') }] } }));
    await writeFile('platform-credentials.json', '{"feishu":{"appSecret":"top-secret"}}');
    const buf = await buildBackupZip({ includeKeys: true });
    const zip = await JSZip.loadAsync(buf);
    const manifest = JSON.parse(await zip.file(BACKUP_MANIFEST_NAME)!.async('string')) as BackupManifest;
    expect(manifest.includesKeys).toBe(true);
    const cfg = JSON.parse(await zip.file(BACKUP_PAYLOAD_PREFIX + 'config.json')!.async('string'));
    expect(cfg.settings.providers[0].apiKey).toBe('sk-real');
    expect(zip.file(BACKUP_PAYLOAD_PREFIX + 'platform-credentials.json')).toBeTruthy();
  });

  it('不含密钥导出：独立密钥文件 platform-credentials.json 被排除（曾整文件泄露）', async () => {
    await writeFile('config.json', '{"settings":{}}');
    await writeFile('platform-credentials.json', '{"feishu":{"appSecret":"top-secret"}}');
    const buf = await buildBackupZip({ includeKeys: false });
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file(BACKUP_PAYLOAD_PREFIX + 'platform-credentials.json')).toBeNull();
  });

  it('不含密钥导出：飞书 user token 文件被排除（S5 新独立密钥文件，与凭证文件同款排除）', async () => {
    await writeFile('config.json', '{"settings":{}}');
    await writeFile('feishu-user-token.json', '{"accessToken":"u-secret","refreshToken":"r-secret"}');
    const buf = await buildBackupZip({ includeKeys: false });
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file(BACKUP_PAYLOAD_PREFIX + 'feishu-user-token.json')).toBeNull();
  });
});
