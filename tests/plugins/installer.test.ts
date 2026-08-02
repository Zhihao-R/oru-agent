/**
 * probePluginFromGithub 的 name 校验（路径穿越防护）
 *
 * manifest.name 会直接当目录名（pluginDir join），必须拒绝含 / \ .. 的名字，
 * 否则 "../../x" 安装时逃逸 ~/.oru/plugins/。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const holder = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../electron/main/plugins/sourceFetch', () => ({
  shallowCloneToTemp: async () => ({ dir: holder.dir, commit: 'deadbeef' }),
  shallowCloneToDir: async () => ({ commit: 'deadbeef' }),
}));

import { probePluginFromGithub } from '../../electron/main/plugins/installer';

async function makePluginDir(name: string): Promise<string> {
  const dir = join(tmpdir(), `oru-plugin-test-${Math.abs(hash(name))}`);
  await fs.mkdir(join(dir, '.claude-plugin'), { recursive: true });
  await fs.writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, description: 'test plugin' }),
    'utf-8',
  );
  return dir;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

describe('probePluginFromGithub name 校验 (M6)', () => {
  beforeEach(() => {
    holder.dir = '';
  });

  it.each(['../../evil', '../escape', 'a/b', '..', '.', 'foo\\bar'])(
    '拒绝非法 name: %s',
    async (name) => {
      holder.dir = await makePluginDir(name);
      await expect(probePluginFromGithub('https://github.com/x/y')).rejects.toThrow(/非法/);
    },
  );

  it('接受合法 name', async () => {
    holder.dir = await makePluginDir('my-plugin');
    const r = await probePluginFromGithub('https://github.com/x/y');
    expect(r.pluginId).toBe('my-plugin');
  });
});
