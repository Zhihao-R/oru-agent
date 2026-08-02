/**
 * 全局 settings 的 desktopPresence 默认与老数据回落（全局点睛 / 系统级唤起对话）：
 * - 老 config 完全没有 desktopPresence → getSettings 回落 { enabled:true }（默认开，PRD §5）。
 * - 老 config 已带 desktopPresence:{enabled:false} → 原样保留（用户关过不被默认开覆盖）。
 *
 * resetModules + 每用例预写 config.json：绕开 store 的 module-level cache，每次首 load 读磁盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-settings-presence-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const OWNER = 'local-user';
const configPath = join(ORU_DIR, 'users', OWNER, 'config.json');

async function writeConfig(settings: Record<string, unknown>): Promise<void> {
  await fs.mkdir(join(ORU_DIR, 'users', OWNER), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({ projects: [], activeId: null, settings }),
    'utf-8',
  );
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('settings.desktopPresence 默认与回落', () => {
  it('老 config 无 desktopPresence → 回落 {enabled:true}', async () => {
    await writeConfig({ theme: 'dark' });
    const { getSettings } = await import('../../electron/main/projects/store');
    const s = await getSettings();
    expect(s.desktopPresence).toEqual({ enabled: true });
  });

  it('老 config 已关过 desktopPresence → 原样保留 {enabled:false}（默认开不覆盖用户选择）', async () => {
    await writeConfig({ desktopPresence: { enabled: false } });
    const { getSettings } = await import('../../electron/main/projects/store');
    const s = await getSettings();
    expect(s.desktopPresence).toEqual({ enabled: false });
  });
});
