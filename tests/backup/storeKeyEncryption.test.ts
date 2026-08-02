/**
 * config store 的密钥落盘边界（S07·G55）——磁盘密文、内存明文、存量明文平滑迁移。
 * 验证承重不变量：apiKey 绝不以明文落进 config.json。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ⚠ ORU_DIR 必须在任何 import 求值前注入：vi.mock('electron') 被 vitest 提升到文件顶部，会
// 连带触发 paths.ts 求值——若此时 env 未设，paths 的 ORU_DIR const 会捕获真实 ~/.oru，测试将
// 在真实数据目录上读写（曾酿成覆盖真实 config.json 的事故）。用 vi.hoisted 与 mock 同相位注入。
const ORU_DIR = vi.hoisted(() => {
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const dir = join(tmpdir(), `oru-test-storekey-${Date.now()}`);
  process.env.ORU_DIR = dir;
  return dir;
});

// 可逆假加密，够验往返 + 「落盘不含明文」
vi.mock('electron', () => ({
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

import { getSettings, updateSettings, __clearCacheForTest } from '../../electron/main/projects/store';
import { configPath, ORU_DIR as PATHS_ORU_DIR } from '../../electron/main/runtime/paths';

// 硬护栏：paths 实际解析的根必须落在 tmp——隔离一旦失效就抛错拒跑，绝不静默污染真实 ~/.oru。
if (!PATHS_ORU_DIR.startsWith(tmpdir())) {
  throw new Error(`ORU_DIR 隔离失效（解析到 ${PATHS_ORU_DIR}）——拒绝在真实数据目录上跑测试`);
}

const OWNER = 'local-user';

async function readRawConfig(): Promise<string> {
  return fs.readFile(configPath(OWNER), 'utf-8');
}

beforeEach(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  __clearCacheForTest();
});
afterEach(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
  __clearCacheForTest();
});

describe('config store 密钥落盘边界', () => {
  it('provider.apiKey 落盘为密文、读回为明文', async () => {
    await updateSettings({
      providers: [{ id: 'p1', type: 'anthropic', label: 'A', apiKey: 'sk-plain-key' }],
    });
    const raw = await readRawConfig();
    expect(raw).not.toContain('sk-plain-key'); // 磁盘绝无明文
    expect(raw).toContain('oru-enc:v1:'); // 磁盘是密文

    __clearCacheForTest(); // 强制从盘 reload
    const s = await getSettings();
    expect(s.providers[0].apiKey).toBe('sk-plain-key'); // 内存态明文
  });

  it('存量明文 config（无前缀）读得回、下次写盘自动固化为密文', async () => {
    // 手写一份「老」config：apiKey 明文、无 version
    await fs.mkdir(join(ORU_DIR, 'users', OWNER), { recursive: true });
    await fs.writeFile(
      configPath(OWNER),
      JSON.stringify({
        projects: [],
        activeId: null,
        settings: { providers: [{ id: 'p1', type: 'anthropic', label: 'A', apiKey: 'legacy-plain' }] },
      }),
    );
    __clearCacheForTest();
    const s = await getSettings();
    expect(s.providers[0].apiKey).toBe('legacy-plain'); // 兼容读回

    // 触发一次写盘（改无关字段）
    await updateSettings({ theme: 'dark' });
    const raw = await readRawConfig();
    expect(raw).not.toContain('legacy-plain'); // 已固化为密文
    expect(raw).toContain('oru-enc:v1:');
  });

  it('webSearch 引擎 key 同样落盘密文、读回明文（密钥字段单一清单覆盖）', async () => {
    await updateSettings({
      webSearch: { enabled: true, engines: [{ id: 'e1', type: 'bocha', apiKey: 'sk-search-key' }], longPageSummary: true },
    });
    const raw = await readRawConfig();
    expect(raw).not.toContain('sk-search-key'); // 磁盘无明文
    expect(raw).toContain('oru-enc:v1:');

    __clearCacheForTest();
    const s = await getSettings();
    expect(s.webSearch?.engines[0].apiKey).toBe('sk-search-key'); // 内存明文
  });

  it('空 apiKey 不被加密（原样空串）', async () => {
    await updateSettings({
      providers: [{ id: 'p1', type: 'anthropic', label: 'A', apiKey: '' }],
    });
    const raw = await readRawConfig();
    expect(raw).toContain('"apiKey": ""');
  });
});
