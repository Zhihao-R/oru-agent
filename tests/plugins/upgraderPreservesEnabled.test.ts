/**
 * 回归：plugin 升级重写 .oru-plugin.json 必须保留盘上 enabled 键
 *
 * 修复前 performPluginUpdate 用内存 oruExtension 重组整份文件——oruExtension 不含
 * enabled（它是盘上独立顶层键，registry 读、缺失视同 true），重写后键丢失，
 * 已禁用的 plugin 升级后重载即静默「复活」。盘是跨重启的真相源，重写要以盘上
 * 现文件为基底只改 source.commit。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginUpdateProposal } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-upgrade-enabled-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

// simple-git 第三方 API 面太大，整面 satisfies 不现实——只 stub 升级路径用到的
// fetch / checkout，经 unknown 收窄到模块默认导出类型（签名漂移会在运行期立刻暴露）
vi.mock('simple-git', () => ({
  default: (() => ({
    fetch: async () => undefined,
    checkout: async () => undefined,
  })) as unknown as (typeof import('simple-git'))['default'],
}));

// chip 落盘 / plugins.state 广播不是本测对象——mock 掉，避免牵动 conversation 存储
vi.mock('../../electron/main/skills/chipWriter', () => ({
  writeSkillModuleChip: vi.fn(async () => undefined),
  broadcastPluginsState: vi.fn(async () => undefined),
}) satisfies Partial<typeof import('../../electron/main/skills/chipWriter')>);

const PLUGIN_ID = 'demo-plugin';
const OLD_COMMIT = 'a'.repeat(40);
const NEW_COMMIT = 'b'.repeat(40);

function makeProposal(): PluginUpdateProposal {
  return {
    id: 'proposal-1',
    ownerId: 'local-user',
    conversationId: 'conv-1',
    title: '升级 plugin Demo',
    description: 'test',
    createdAt: Date.now(),
    status: 'pending', // pending → executed/failed 直达，真 lifecycle 可走
    kind: 'plugin.update',
    pluginId: PLUGIN_ID,
    fromCommit: OLD_COMMIT,
    toCommit: NEW_COMMIT,
    diffSummary: { keyFiles: [], otherFilesCount: 0 },
  };
}

describe('performPluginUpdate 保留盘上 enabled（升级不复活已禁用 plugin）', () => {
  const pluginDirPath = join(ORU_DIR, 'plugins', PLUGIN_ID);

  beforeAll(async () => {
    await fs.mkdir(join(pluginDirPath, '.claude-plugin'), { recursive: true });
    await fs.writeFile(
      join(pluginDirPath, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'Demo Plugin', description: 'demo' }),
      'utf-8',
    );
    // 盘上真相：用户已禁用该 plugin
    await fs.writeFile(
      join(pluginDirPath, '.oru-plugin.json'),
      JSON.stringify(
        {
          source: { type: 'github', url: 'https://example.com/x.git', commit: OLD_COMMIT },
          installedAt: 1,
          enabled: false,
        },
        null,
        2,
      ),
      'utf-8',
    );
  });

  afterAll(async () => {
    const { __resetForTest } = await import('../../electron/main/plugins/registry');
    __resetForTest();
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('禁用的 plugin 走升级 → 盘上 enabled:false 保留、重载后仍禁用', async () => {
    const { loadPluginFromDir, upsertPlugin, getPlugin } = await import(
      '../../electron/main/plugins/registry'
    );
    const { performPluginUpdate } = await import('../../electron/main/plugins/upgrader');

    const record = await loadPluginFromDir(PLUGIN_ID, pluginDirPath);
    expect(record).not.toBeNull();
    expect(record!.enabled).toBe(false);
    upsertPlugin(record!);

    const proposal = makeProposal();
    // 直接测纯执行内核：「走的是成功路径」由「不抛错」天然保证（失败一律 throw），
    // 不必绕独立执行器去看 proposal.status。
    await expect(performPluginUpdate(proposal)).resolves.toMatchObject({ pluginId: PLUGIN_ID });

    // 盘上：enabled 保留、commit 已更、其余顶层键不丢
    const onDisk = JSON.parse(
      await fs.readFile(join(pluginDirPath, '.oru-plugin.json'), 'utf-8'),
    );
    expect(onDisk.enabled).toBe(false);
    expect(onDisk.source.commit).toBe(NEW_COMMIT);
    expect(onDisk.installedAt).toBe(1);

    // 重载后（performPluginUpdate 内部已重建注册表条目）仍禁用——修复前这里「复活」成 true
    expect(getPlugin(PLUGIN_ID)?.enabled).toBe(false);
  });
});
