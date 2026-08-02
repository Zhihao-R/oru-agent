/**
 * memory/trash.ts 单元测试
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-trash-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const OWNER = 'trash-owner';

describe('memory/trash', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('moveToTrash 把文件挪走 + 同步删索引', async () => {
    const { writeEpisode, upsertIndexEntry, readIndex } = await import(
      '../../electron/main/memory/store'
    );
    const { moveToTrash } = await import('../../electron/main/memory/trash');
    const { memoryRoot } = await import('../../electron/main/memory/paths');

    const relPath = await writeEpisode({
      ownerId: OWNER,
      scopeName: 'agent',
      scopeId: 'twin',
      slug: '要删的',
      frontmatter: {
        scope: 'agent',
        tags: [],
        status: 'active',
        created: '2026-04-30',
        source: 'twin-auto',
      },
      body: 'will be trashed',
    });
    await upsertIndexEntry(OWNER, {
      relPath,
      title: '要删的',
      scope: 'agent',
      tags: [],
    });

    const abs = join(memoryRoot(OWNER), relPath);
    expect(existsSync(abs)).toBe(true);

    const dest = await moveToTrash(OWNER, abs);
    expect(existsSync(abs)).toBe(false);
    expect(existsSync(dest)).toBe(true);

    const idx = await readIndex(OWNER);
    expect(idx.find((e) => e.relPath === relPath)).toBeUndefined();
  });

  it('moveToTrash 对不存在的文件幂等不抛', async () => {
    const { moveToTrash } = await import('../../electron/main/memory/trash');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const abs = join(memoryRoot(OWNER), 'nonexistent.md');
    await expect(moveToTrash(OWNER, abs)).resolves.toBeDefined();
  });

  it('cleanupOldTrash 清掉超过 N 天的子目录', async () => {
    const { cleanupOldTrash } = await import('../../electron/main/memory/trash');
    const { memoryRoot } = await import('../../electron/main/memory/paths');

    // 手动造几个 trash 子目录：一个老的、一个新的
    const trashRoot = join(memoryRoot(OWNER), 'trash');
    await fs.mkdir(join(trashRoot, '2025-01-01'), { recursive: true });
    await fs.writeFile(join(trashRoot, '2025-01-01', 'old.md'), 'old', 'utf-8');
    const today = new Date().toISOString().slice(0, 10);
    await fs.mkdir(join(trashRoot, today), { recursive: true });
    await fs.writeFile(join(trashRoot, today, 'new.md'), 'new', 'utf-8');

    const deleted = await cleanupOldTrash(OWNER, 30);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(trashRoot, '2025-01-01'))).toBe(false);
    expect(existsSync(join(trashRoot, today))).toBe(true);
  });
  it('scanTrashedProfiles 只报档案（profile.md/self.md），episode 与其他文件不报', async () => {
    const { scanTrashedProfiles } = await import('../../electron/main/memory/trash');
    const { memoryRoot } = await import('../../electron/main/memory/paths');

    // 独立 owner，避免与本文件其他用例的回收站内容串味
    const owner = 'trash-scan-owner';
    const trashRoot = join(memoryRoot(owner), 'trash');
    const day = '2026-07-20';
    // 档案两份（agent self + 项目 profile）、episode 一份、无关文件一份
    for (const [rel, body] of [
      ['agents/twin/self.md', '档案 self'],
      ['projects/p1/profile.md', '档案 project'],
      ['agents/twin/episodes/2026-07-01-x.md', 'episode'],
      ['MEMORY.md', '索引'],
    ] as const) {
      const f = join(trashRoot, day, rel);
      await fs.mkdir(join(f, '..'), { recursive: true });
      await fs.writeFile(f, body, 'utf-8');
    }

    const found = await scanTrashedProfiles(owner);
    expect(found.sort()).toEqual([
      `${day}/agents/twin/self.md`,
      `${day}/projects/p1/profile.md`,
    ]);
  });

  it('scanTrashedProfiles 回收站不存在 → 空数组', async () => {
    const { scanTrashedProfiles } = await import('../../electron/main/memory/trash');
    expect(await scanTrashedProfiles('trash-scan-empty-owner')).toEqual([]);
  });
});
