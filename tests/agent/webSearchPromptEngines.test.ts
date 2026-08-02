/**
 * 系统提示词的「当前可用引擎与擅长」清单（AnySearch 接入·批 2）
 *
 * 覆盖：两家以上有效引擎 → 追加清单（type + 擅长）；只配一家 → 不拼清单（模型无从传
 * engine 参数）；空 key 条目不算配置；总开关关 → 整段为空。
 * ORU_DIR 沙箱写原始 config 走真实 store 路径（同 selectorPreferred.test）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-ws-prompt-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const userDir = join(ORU_DIR, 'users', 'local-user');
const configFile = join(userDir, 'config.json');

type EngineRow = { id: string; type: string; apiKey: string };

async function writeConfig(enabled: boolean, engines: EngineRow[]): Promise<void> {
  const { __clearCacheForTest } = await import('../../electron/main/projects/store');
  await fs.writeFile(
    configFile,
    JSON.stringify({
      projects: [],
      activeId: null,
      settings: { webSearch: { enabled, engines, longPageSummary: true } },
    }),
    'utf-8',
  );
  __clearCacheForTest();
}

beforeAll(async () => {
  await fs.mkdir(userDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('loadWebSearchPromptIfEnabled · 引擎清单', () => {
  it('两家有效引擎 → 追加清单，每行 type + 擅长', async () => {
    await writeConfig(true, [
      { id: 'e1', type: 'bocha', apiKey: 'bk' },
      { id: 'e2', type: 'anysearch', apiKey: 'ak' },
    ]);
    const { loadWebSearchPromptIfEnabled } = await import(
      '../../electron/main/agent/webSearchPrompt'
    );
    const p = await loadWebSearchPromptIfEnabled();
    expect(p).toContain('当前可用搜索引擎与擅长');
    expect(p).toMatch(/- bocha：.*中文/);
    expect(p).toMatch(/- anysearch：.*技术/);
  });

  it('只配一家 → 返回原 prompt，不拼清单', async () => {
    await writeConfig(true, [{ id: 'e1', type: 'bocha', apiKey: 'bk' }]);
    const { loadWebSearchPromptIfEnabled } = await import(
      '../../electron/main/agent/webSearchPrompt'
    );
    const p = await loadWebSearchPromptIfEnabled();
    expect(p.length).toBeGreaterThan(0);
    expect(p).not.toContain('当前可用搜索引擎与擅长');
  });

  it('空 key 条目不算配置：两条里一条空 key → 视同只配一家，不拼清单', async () => {
    await writeConfig(true, [
      { id: 'e1', type: 'bocha', apiKey: 'bk' },
      { id: 'e2', type: 'anysearch', apiKey: '  ' },
    ]);
    const { loadWebSearchPromptIfEnabled } = await import(
      '../../electron/main/agent/webSearchPrompt'
    );
    expect(await loadWebSearchPromptIfEnabled()).not.toContain('当前可用搜索引擎与擅长');
  });

  it('总开关关 → 空串', async () => {
    await writeConfig(false, [
      { id: 'e1', type: 'bocha', apiKey: 'bk' },
      { id: 'e2', type: 'anysearch', apiKey: 'ak' },
    ]);
    const { loadWebSearchPromptIfEnabled } = await import(
      '../../electron/main/agent/webSearchPrompt'
    );
    expect(await loadWebSearchPromptIfEnabled()).toBe('');
  });
});
