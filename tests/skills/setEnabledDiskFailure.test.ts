/**
 * A7 回归：setSkillEnabled / setPluginEnabled 写盘失败必须沿调用链抛出
 * （router 据此回 ok=false / error），且内存状态与盘上状态不劈叉——
 * 修复前失败被 console.warn 吞掉仍回 ok，用户关掉的能力重启后「诈尸」。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginRecord, SkillRecord } from '@shared/types';

// 包一层 spy：默认走真函数（可验成功路径确实经原子写内核），单测里按需 mock 抛错
vi.mock('../../electron/main/fs/safeWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/fs/safeWrite')>();
  return {
    ...actual,
    safeWriteAsync: vi.fn(actual.safeWriteAsync),
  } satisfies typeof import('../../electron/main/fs/safeWrite');
});

const ORU_DIR = join(tmpdir(), `oru-test-setenabled-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const SKILL_ID = 'demo-skill';
const PLUGIN_ID = 'demo-plugin';

function makeSkill(path: string): SkillRecord {
  return {
    id: SKILL_ID,
    name: 'Demo Skill',
    description: 'demo',
    path,
    source: 'standalone',
    availableFromTimestamp: 0,
    enabled: true,
  };
}

function makePlugin(): PluginRecord {
  return {
    id: PLUGIN_ID,
    manifest: { name: 'Demo Plugin', description: 'demo' },
    oruExtension: {
      source: { type: 'github', url: 'https://example.com/x.git', commit: 'abc' },
      installedAt: 1,
    },
    skills: [],
    mcpServers: [],
    ignoredSections: [],
    enabled: true,
  };
}

describe('setEnabled 写盘失败传播（A7）', () => {
  beforeAll(async () => {
    await fs.mkdir(join(ORU_DIR, 'skills', SKILL_ID), { recursive: true });
    await fs.mkdir(join(ORU_DIR, 'plugins', PLUGIN_ID), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  afterEach(async () => {
    const skillReg = await import('../../electron/main/skills/registry');
    const pluginReg = await import('../../electron/main/plugins/registry');
    skillReg.__resetForTest();
    pluginReg.__resetForTest();
    vi.mocked((await import('../../electron/main/fs/safeWrite')).safeWriteAsync).mockClear();
  });

  it('setSkillEnabled：写盘失败 → 调用方收到 reject，内存保持旧值（与盘一致）', async () => {
    const { upsertSkill, getSkill, setSkillEnabled } = await import(
      '../../electron/main/skills/registry'
    );
    const { safeWriteAsync } = await import('../../electron/main/fs/safeWrite');
    upsertSkill(makeSkill(join(ORU_DIR, 'skills', SKILL_ID)));

    vi.mocked(safeWriteAsync).mockRejectedValueOnce(new Error('ENOSPC: 模拟写盘失败'));
    await expect(setSkillEnabled(SKILL_ID, false)).rejects.toThrow('ENOSPC');

    // 内存没被翻——盘上没写成，内存也不能装作关了（否则重启诈尸）
    expect(getSkill(SKILL_ID)?.enabled).toBe(true);
  });

  it('setSkillEnabled：成功路径经 safeWriteAsync 落 sidecar，内存同步翻转', async () => {
    const { upsertSkill, getSkill, setSkillEnabled } = await import(
      '../../electron/main/skills/registry'
    );
    const { safeWriteAsync } = await import('../../electron/main/fs/safeWrite');
    const skillPath = join(ORU_DIR, 'skills', SKILL_ID);
    upsertSkill(makeSkill(skillPath));

    await expect(setSkillEnabled(SKILL_ID, false)).resolves.toBe('ok');

    expect(getSkill(SKILL_ID)?.enabled).toBe(false);
    expect(vi.mocked(safeWriteAsync)).toHaveBeenCalledWith(
      join(skillPath, '.oru-skill.json'),
      expect.any(String),
    );
    const sidecar = JSON.parse(await fs.readFile(join(skillPath, '.oru-skill.json'), 'utf-8'));
    expect(sidecar.enabled).toBe(false);
  });

  it('setPluginEnabled：写盘失败 → 调用方收到 reject，内存保持旧值（与盘一致）', async () => {
    const { upsertPlugin, getPlugin, setPluginEnabled } = await import(
      '../../electron/main/plugins/registry'
    );
    const { safeWriteAsync } = await import('../../electron/main/fs/safeWrite');
    upsertPlugin(makePlugin());

    vi.mocked(safeWriteAsync).mockRejectedValueOnce(new Error('EROFS: 模拟写盘失败'));
    await expect(setPluginEnabled(PLUGIN_ID, false)).rejects.toThrow('EROFS');

    expect(getPlugin(PLUGIN_ID)?.enabled).toBe(true);
  });

  it('setPluginEnabled：成功路径经 safeWriteAsync 落 .oru-plugin.json，内存同步翻转', async () => {
    const { upsertPlugin, getPlugin, setPluginEnabled } = await import(
      '../../electron/main/plugins/registry'
    );
    upsertPlugin(makePlugin());

    await expect(setPluginEnabled(PLUGIN_ID, false)).resolves.toBe(true);

    expect(getPlugin(PLUGIN_ID)?.enabled).toBe(false);
    const onDisk = JSON.parse(
      await fs.readFile(join(ORU_DIR, 'plugins', PLUGIN_ID, '.oru-plugin.json'), 'utf-8'),
    );
    expect(onDisk.enabled).toBe(false);
    expect(onDisk.installedAt).toBe(1); // oruExtension 原字段保留
  });
});
