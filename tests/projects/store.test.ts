/**
 * projects/store.ts config 损坏隔离保留回归（§Deg / G126）
 *
 * 直接对着数据丢失面写：config.json 一坏，「信任与组织结构」（项目定义 + 平台白名单 + providers）
 * 整份清零。旧行为回落默认并 cache.set，下一次 persist 即把损坏文件物理覆盖 → 原数据不可逆丢失。
 * 修后应先隔离原字节到 sidecar 再降级，故必须验到磁盘字节层面（sidecar 内容 == 原损坏字节）。
 *
 * ORU_DIR 范式：顶层先设 env、store 全部动态 import（同 conversations/store.test.ts），
 * 避免 runtime/paths 在 module load 时锁死 ORU_DIR。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-projects-store-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'local-user';
const userDir = join(ORU_DIR, 'users', OWNER);
const configFile = join(userDir, 'config.json');

async function corruptSidecars(): Promise<string[]> {
  const entries = await fs.readdir(userDir).catch(() => [] as string[]);
  return entries.filter((n) => n.startsWith('config.json.corrupt-'));
}

beforeAll(async () => {
  await fs.mkdir(userDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('projects/store - config 损坏隔离保留（§Deg）', () => {
  it('config.json 损坏 → 隔离原字节保全、回落默认，后续 persist 落新文件不覆盖损坏字节', async () => {
    const { getSettings, updateSettings, listProjects, __clearCacheForTest } = await import(
      '../../electron/main/projects/store'
    );
    // 一份「里头有真实项目 + 自定义 provider」的合法结构，但整体被截断成无法 parse
    const corrupt =
      '{"projects":[{"id":"proj_keep","path":"/tmp/keep"}],"activeId":"proj_keep","settings":{"providers":[{"id":"prov_x"';
    await fs.writeFile(configFile, corrupt, 'utf-8');
    __clearCacheForTest(); // 强制下次 load 读盘

    // 隔离降级：优雅回落默认（不抛），项目列表空、设置为默认
    const settings = await getSettings();
    expect(settings.providers).toEqual([]);
    expect((await listProjects()).projects).toEqual([]);

    // 损坏文件被移出正常路径、原字节进 sidecar
    const sidecars = await corruptSidecars();
    expect(sidecars).toHaveLength(1);
    expect(await fs.readFile(join(userDir, sidecars[0]), 'utf-8')).toBe(corrupt);

    // 关键：后续写盘落全新 config.json，损坏字节安在 sidecar，不被物理覆盖
    await updateSettings({ colorScheme: 'terracotta' });
    const after = JSON.parse(await fs.readFile(configFile, 'utf-8'));
    expect(after.settings.colorScheme).toBe('terracotta');
    expect(await fs.readFile(join(userDir, sidecars[0]), 'utf-8')).toBe(corrupt); // 原字节仍在
  });
});

// ─── removeProject：删 profile/list-entry → 回收站，episodes 保留 ─────────────
describe('projects/store — removeProject 的记忆清理（删档案留事件）', () => {
  const memoryProjects = join(userDir, 'memory', 'projects');
  const P1 = 'prj_testRemove1';

  it('删除项目：config 列表剔除 + profile/list-entry 进回收站 + episodes 保留', async () => {
    const { removeProject, listProjects, __clearCacheForTest } = await import(
      '../../electron/main/projects/store'
    );
    const memoryRoot = join(userDir, 'memory');
    const projDir = join(memoryProjects, P1);
    await fs.mkdir(join(projDir, 'episodes'), { recursive: true });
    await fs.writeFile(join(projDir, 'profile.md'), '# profile', 'utf-8');
    await fs.writeFile(join(projDir, 'list-entry.md'), 'intro', 'utf-8');
    await fs.writeFile(join(projDir, 'episodes', '2026-08-03-foo.md'), '# ep', 'utf-8');

    // 常规项目添加，随后直接走 removeProject（用内存里的项目 id 语义）
    // config 需要存在该项目，先构造并清缓存
    await fs.writeFile(
      configFile,
      JSON.stringify({
        projects: [
          {
            id: P1,
            ownerId: OWNER,
            name: 't',
            path: '/tmp/t',
            addedAt: 0,
            lastOpenedAt: 0,
            hasClaudeMd: false,
          },
        ],
        activeId: P1,
        settings: {},
      }),
      'utf-8',
    );
    __clearCacheForTest();

    await removeProject(P1);

    // config 列表已剔除
    expect((await listProjects()).projects.map((p) => p.id)).not.toContain(P1);
    // profile/list-entry 不再在原位（被移走，未物理删除）
    expect(await fs.stat(join(projDir, 'profile.md')).catch(() => null)).toBeNull();
    expect(await fs.stat(join(projDir, 'list-entry.md')).catch(() => null)).toBeNull();
    // 回收站里能找到（可恢复），相对路径保留 projects/<id>/profile.md
    const trashRoot = join(memoryRoot, 'trash');
    const trashFiles = await __walk(trashRoot);
    expect(trashFiles.some((f) => f.endsWith(`projects/${P1}/profile.md`))).toBe(true);
    expect(trashFiles.some((f) => f.endsWith(`projects/${P1}/list-entry.md`))).toBe(true);
    // episodes 原样保留
    expect(await fs.readFile(join(projDir, 'episodes', '2026-08-03-foo.md'), 'utf-8')).toBe('# ep');

    // 清掉项目目录残留（episodes 保留），恢复现场
    await fs.rm(join(userDir, 'memory'), { recursive: true, force: true });
    await fs.unlink(configFile);
    __clearCacheForTest();
  });
});

async function __walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await __walk(full)));
    else out.push(full);
  }
  return out;
}

describe('projects/store — 格式版本号（S06）', () => {
  it('写盘带 version 字段；无 version 的老文件（当前基线）照常读', async () => {
    const { getSettings, updateSettings, __clearCacheForTest } = await import(
      '../../electron/main/projects/store'
    );
    // 老格式：无 version
    await fs.writeFile(
      configFile,
      JSON.stringify({ projects: [], activeId: null, settings: { colorScheme: 'sage' } }),
      'utf-8',
    );
    __clearCacheForTest();
    expect((await getSettings()).colorScheme).toBe('sage');
    // 下次写盘固化版本号
    await updateSettings({ theme: 'dark' });
    const raw = JSON.parse(await fs.readFile(configFile, 'utf-8'));
    expect(typeof raw.version).toBe('number');
    expect(raw.settings.theme).toBe('dark');
  });

  it('keepAwake 默认关 + 老数据缺省回落（技术设计 §5.2）：无字段 = { enabled:false }', async () => {
    const { getSettings, updateSettings, __clearCacheForTest } = await import(
      '../../electron/main/projects/store'
    );
    // 老数据无 keepAwake 字段 → load 回落默认关
    await fs.writeFile(
      configFile,
      JSON.stringify({ projects: [], activeId: null, settings: { colorScheme: 'sage' } }),
      'utf-8',
    );
    __clearCacheForTest();
    expect((await getSettings()).keepAwake).toEqual({ enabled: false });

    // 用户打开 → 持久化
    await updateSettings({ keepAwake: { enabled: true } });
    __clearCacheForTest();
    expect((await getSettings()).keepAwake).toEqual({ enabled: true });
  });

  it('未来版本 config → 如实拒绝（抛），不隔离、不写回降级', async () => {
    const { getSettings, __clearCacheForTest } = await import('../../electron/main/projects/store');
    const { FutureSchemaVersionError } = await import('../../electron/main/runtime/migrateOnRead');
    const futureBytes = JSON.stringify({ version: 99, projects: [], activeId: null, settings: {} });
    await fs.writeFile(configFile, futureBytes, 'utf-8');
    __clearCacheForTest();
    const before = await corruptSidecars();
    await expect(getSettings()).rejects.toThrow(FutureSchemaVersionError);
    // 不当损坏隔离（它不是损坏），文件字节原样
    expect(await corruptSidecars()).toEqual(before);
    expect(await fs.readFile(configFile, 'utf-8')).toBe(futureBytes);
    // 恢复现场（后续测试文件共享 sandbox）
    await fs.unlink(configFile);
    __clearCacheForTest();
  });
});
