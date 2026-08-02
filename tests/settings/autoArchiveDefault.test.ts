/**
 * 全局 settings 的 autoArchive 默认与老数据回落（对话归档）：
 * - 老 config 完全没有 autoArchive → getSettings 回落 { enabled:true, thresholdHours:168 }。
 * - 老 config 有 autoArchive 但缺 thresholdHours → 保留 enabled、补默认 thresholdHours（嵌套补齐）。
 *
 * resetModules + 每用例预写 config.json：绕开 store 的 module-level cache，每次首 load 读磁盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-settings-autoarchive-${Date.now()}`);
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

describe('settings.autoArchive 默认与回落', () => {
  it('老 config 无 autoArchive → 回落 {enabled:true, thresholdHours:168}', async () => {
    await writeConfig({ theme: 'dark' });
    const { getSettings } = await import('../../electron/main/projects/store');
    const s = await getSettings();
    expect(s.autoArchive).toEqual({ enabled: true, thresholdHours: 168 });
  });

  it('老 config autoArchive 缺 thresholdHours → 保留 enabled、补默认 168', async () => {
    await writeConfig({ autoArchive: { enabled: false } });
    const { getSettings } = await import('../../electron/main/projects/store');
    const s = await getSettings();
    expect(s.autoArchive).toEqual({ enabled: false, thresholdHours: 168 });
  });
});
