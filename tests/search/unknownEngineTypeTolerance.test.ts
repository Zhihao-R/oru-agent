/**
 * 未知引擎类型容错回归（AnySearch 接入·批 1 可移除性地基）
 *
 * 直接对着删除预案写：磁盘 engines 里残留本版本不认识的 type（用户从新版本降级 /
 * 该引擎类型已被删除）时——
 *  1. 运行配置剔除该条目（不再一路活到 makeEngine 的 throw 炸掉搜索链）；
 *  2. 剔除的条目进 unsupportedEngines（设置页灰化展示 + 可删）；
 *  3. 磁盘不丢配置：load 本身不改写文件；后续 persist 把条目并回 engines（条目无损，
 *     顺序并到末尾）。注意：vitest 下 Electron safeStorage 不可用，加密链退化为 no-op，
 *     重读明文断言只验证拆分/并回闭环本身；「apiKey 不被二次加密」靠 persistInLock 里
 *     mergeUnknownEnginesForDisk 在 encryptSettingsForDisk 之前调用保证，本测试覆盖不到。
 *  4. 垃圾条目（null / 缺 id）连灰化行都无从展示，直接丢弃不进 unsupportedEngines。
 *
 * 喂原始 JSON 走真实 parse 路径（store.load），不是 as any 造对象。
 * ORU_DIR 范式：顶层先设 env、store 全部动态 import（同 tests/projects/store.test.ts）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-unknown-engine-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'local-user';
const userDir = join(ORU_DIR, 'users', OWNER);
const configFile = join(userDir, 'config.json');

/** 'ghost' 扮演「本版本不认识的引擎类型」——删除任何一家引擎后，这就是存量用户的真实场景 */
const RAW_CONFIG = {
  projects: [],
  activeId: null,
  settings: {
    webSearch: {
      enabled: true,
      engines: [
        { id: 'eng_bocha', type: 'bocha', apiKey: 'bocha-key' },
        { id: 'eng_ghost', type: 'ghost', apiKey: 'ghost-key', lastTestStatus: 'ok' },
        null, // 垃圾条目：手改/损坏——应被丢弃，不崩、不进灰化区
        { type: 'no-id-engine', apiKey: 'x' }, // 垃圾条目：缺 id，灰化行没法删——同上
      ],
      longPageSummary: true,
    },
  },
};

beforeAll(async () => {
  await fs.mkdir(userDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  const { __clearCacheForTest } = await import('../../electron/main/projects/store');
  await fs.writeFile(configFile, JSON.stringify(RAW_CONFIG, null, 2), 'utf-8');
  __clearCacheForTest();
});

describe('未知引擎类型容错（反序列化层）', () => {
  it('运行配置剔除未知条目、其余引擎正常；剔除条目原样进 unsupportedEngines、垃圾条目丢弃', async () => {
    const { getSettings } = await import('../../electron/main/projects/store');
    const ws = (await getSettings()).webSearch!;

    expect(ws.engines.map((e) => e.type)).toEqual(['bocha']);
    expect(ws.unsupportedEngines).toEqual([
      { id: 'eng_ghost', type: 'ghost', apiKey: 'ghost-key', lastTestStatus: 'ok' },
    ]);
  });

  it('load 本身不改写磁盘', async () => {
    const before = await fs.readFile(configFile, 'utf-8');
    const { getSettings } = await import('../../electron/main/projects/store');
    await getSettings();
    expect(await fs.readFile(configFile, 'utf-8')).toBe(before);
  });

  it('后续 persist：未知条目并回磁盘 engines，运行时字段不落盘，重读闭环条目无损', async () => {
    const { getSettings, updateSettings, __clearCacheForTest } = await import(
      '../../electron/main/projects/store'
    );
    await getSettings();
    await updateSettings({ theme: 'dark' }); // 无关改动触发 persist

    const onDisk = JSON.parse(await fs.readFile(configFile, 'utf-8'));
    const diskEngines = onDisk.settings.webSearch.engines as Array<{ id: string; type: string }>;
    expect(diskEngines.map((e) => e.type).sort()).toEqual(['bocha', 'ghost']);
    expect(onDisk.settings.webSearch.unsupportedEngines).toBeUndefined();

    // 重读闭环：ghost 条目再次被剔除、字段无损（加密边界在 vitest 下是 no-op，见文件头注 3）
    __clearCacheForTest();
    const ws = (await getSettings()).webSearch!;
    expect(ws.unsupportedEngines?.[0]).toMatchObject({ id: 'eng_ghost', apiKey: 'ghost-key' });
  });

  it('用户在设置页删除灰化条目 → 磁盘 engines 不再含它', async () => {
    const { getSettings, updateSettings } = await import('../../electron/main/projects/store');
    const ws = (await getSettings()).webSearch!;
    await updateSettings({ webSearch: { ...ws, unsupportedEngines: [] } });

    const onDisk = JSON.parse(await fs.readFile(configFile, 'utf-8'));
    expect(
      (onDisk.settings.webSearch.engines as Array<{ type: string }>).map((e) => e.type),
    ).toEqual(['bocha']);
  });
});
