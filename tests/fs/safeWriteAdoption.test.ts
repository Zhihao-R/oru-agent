/**
 * A6 回归：改写既有文本文件必须走 fs/safeWrite 原子写内核（tmp+rename），不走裸 fs.writeFile。
 *
 * 六处收口点里挑两处代表写 spy 断言（identity/profile 与 migrate 的 agents.json 修补）；
 * 其余四处（skills/manager patch、plugins/registry、plugins/upgrader、memory/projectList）
 * 同构转换：skills/registry 与 plugins/registry 由 setEnabledDiskFailure.test.ts 的
 * safeWriteAsync mock 间接证明写路径，剩余由实现时 grep 核对（该文件不再含目标行的裸 writeFile）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 包一层 spy 验证写盘走 safeWriteAsync（原子写内核）；实现仍是真函数，不改写盘行为
vi.mock('../../electron/main/fs/safeWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/fs/safeWrite')>();
  return {
    ...actual,
    safeWriteAsync: vi.fn(actual.safeWriteAsync),
  } satisfies typeof import('../../electron/main/fs/safeWrite');
});

const ORU_DIR = join(tmpdir(), `oru-test-safewrite-adoption-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

describe('safeWrite 收口（A6）', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('identity/profile：updateProfile 落盘走 safeWriteAsync', async () => {
    const { getProfile, updateProfile, __resetProfileCache } = await import(
      '../../electron/main/identity/profile'
    );
    const { profilePath } = await import('../../electron/main/runtime/paths');
    const { safeWriteAsync } = await import('../../electron/main/fs/safeWrite');
    __resetProfileCache();

    const ownerId = 'owner-a6';
    await getProfile(ownerId); // 首建默认 profile
    vi.mocked(safeWriteAsync).mockClear();

    await updateProfile(ownerId, { name: '新名字' });

    expect(vi.mocked(safeWriteAsync)).toHaveBeenCalledWith(
      profilePath(ownerId),
      expect.any(String),
    );
    // 改写既有文件生效且仍是合法 JSON
    const onDisk = JSON.parse(await fs.readFile(profilePath(ownerId), 'utf-8'));
    expect(onDisk.name).toBe('新名字');
  });

  it('migrate：agents.json 的 homePath 修补落盘走 safeWriteAsync', async () => {
    const { migrateToUserScopedLayout } = await import('../../electron/main/migrate');
    const { LOCAL_USER_ID } = await import('../../electron/main/identity/getCurrentOwnerId');
    const { userDir } = await import('../../electron/main/runtime/paths');
    const { safeWriteAsync } = await import('../../electron/main/fs/safeWrite');

    // 老布局：~/.oru/agents.json 里 homePath 指向老 ~/.oru/agents/*
    const oldIndex = {
      agents: [{ id: 'a1', homePath: join(ORU_DIR, 'agents', 'a1') }],
      activeId: 'a1',
    };
    await fs.writeFile(join(ORU_DIR, 'agents.json'), JSON.stringify(oldIndex), 'utf-8');
    vi.mocked(safeWriteAsync).mockClear();

    await migrateToUserScopedLayout();

    const newIndexPath = join(userDir(LOCAL_USER_ID), 'agents.json');
    expect(vi.mocked(safeWriteAsync)).toHaveBeenCalledWith(newIndexPath, expect.any(String));
    const migrated = JSON.parse(await fs.readFile(newIndexPath, 'utf-8'));
    expect(migrated.agents[0].homePath).toBe(join(userDir(LOCAL_USER_ID), 'agents', 'a1'));
  });
});
