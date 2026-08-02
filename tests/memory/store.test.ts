/**
 * memory/store.ts 单元测试
 *
 * 必须通过 process.env.ORU_DIR 重定向到 tmpdir，所有 import 都用 await import 动态加载，
 * 避免 runtime/paths.ts 在 module load 时把 ORU_DIR 锁死。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as safeWriteMod from '../../electron/main/fs/safeWrite';

const ORU_DIR = join(tmpdir(), `oru-test-memory-store-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'test-owner';

describe('memory/store - long-form', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('readLongForm 不存在的文件返回 null（顶层 helper），但 readPersonalFacts 等返回空字符串', async () => {
    const { readLongForm, readPersonalPreferences } = await import(
      '../../electron/main/memory/store'
    );
    expect(await readLongForm('/tmp/nonexistent-xyz.md')).toBeNull();
    // readPersonalPreferences 等 long-form helper 把 null 转成 ''
    expect(await readPersonalPreferences('fresh-owner-' + Date.now())).toBe('');
  });
});

describe('memory/store - episodes', () => {
  it('writeEpisode 后能 listEpisodes 看到，readEpisode 能拿回 frontmatter', async () => {
    const { writeEpisode, listEpisodes, readEpisode } = await import(
      '../../electron/main/memory/store'
    );
    const relPath = await writeEpisode({
      ownerId: OWNER,
      scopeName: 'agent',
      scopeId: 'twin',
      slug: '聊了-prd',
      frontmatter: {
        scope: 'agent',
        tags: ['PRD', '记忆系统'],
        status: 'active',
        created: '2026-04-30',
        source: 'user-direct',
      },
      body: '今天讨论了 PRD v0.4。',
    });
    expect(relPath).toMatch(/^agents\/twin\/episodes\/2026-04-30-聊了-prd\.md$/);

    const list = await listEpisodes(OWNER, 'agent', 'twin');
    expect(list).toContain(relPath);

    const ep = await readEpisode(OWNER, relPath);
    expect(ep).not.toBeNull();
    expect(ep!.frontmatter.status).toBe('active');
    expect(ep!.frontmatter.tags).toEqual(['PRD', '记忆系统']);
    expect(ep!.body.trim()).toBe('今天讨论了 PRD v0.4。');
  });
});

describe('memory/store - 索引', () => {
  it('writeIndex 后 readIndex 一致', async () => {
    const { writeIndex, readIndex } = await import('../../electron/main/memory/store');
    const entries = [
      { relPath: 'agents/twin/episodes/2026-04-30-a.md', title: 'A 事件', scope: 'agent', tags: ['x'] },
      {
        relPath: 'projects/oru/episodes/2026-04-30-b.md',
        title: 'B 事件',
        scope: 'project:oru',
        tags: ['y', 'z'],
      },
    ];
    await writeIndex(OWNER, entries);
    const back = await readIndex(OWNER);
    expect(back.length).toBe(2);
    expect(back[0].title).toBe('A 事件');
    expect(back[0].tags).toEqual(['x']);
    expect(back[1].scope).toBe('project:oru');
  });

  it('upsertIndexEntry 已有同 relPath 的会覆盖', async () => {
    const { writeIndex, upsertIndexEntry, readIndex } = await import(
      '../../electron/main/memory/store'
    );
    await writeIndex(OWNER, [
      { relPath: 'a.md', title: '旧', scope: 'agent', tags: [] },
    ]);
    await upsertIndexEntry(OWNER, {
      relPath: 'a.md',
      title: '新',
      scope: 'agent',
      tags: ['t'],
    });
    const back = await readIndex(OWNER);
    expect(back.length).toBe(1);
    expect(back[0].title).toBe('新');
    expect(back[0].tags).toEqual(['t']);
  });

  it('removeIndexEntry 删除后不再存在', async () => {
    const { writeIndex, removeIndexEntry, readIndex } = await import(
      '../../electron/main/memory/store'
    );
    await writeIndex(OWNER, [
      { relPath: 'a.md', title: 'A', scope: 'agent', tags: [] },
      { relPath: 'b.md', title: 'B', scope: 'agent', tags: [] },
    ]);
    await removeIndexEntry(OWNER, 'a.md');
    const back = await readIndex(OWNER);
    expect(back.length).toBe(1);
    expect(back[0].relPath).toBe('b.md');
  });

  // T2 / M4：并发 upsert 的 read-modify-write 必须整块持锁，否则后写覆盖先写、丢条目
  it('并发 upsertIndexEntry 不丢条目', async () => {
    const { writeIndex, upsertIndexEntry, readIndex } = await import(
      '../../electron/main/memory/store'
    );
    const CONC_OWNER = 'concurrent-index-owner';
    await writeIndex(CONC_OWNER, []);
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        upsertIndexEntry(CONC_OWNER, {
          relPath: `ep-${i}.md`,
          title: `E${i}`,
          scope: 'agent',
          tags: [],
        }),
      ),
    );
    const back = await readIndex(CONC_OWNER);
    expect(back.length).toBe(N);
    expect(new Set(back.map((e) => e.relPath)).size).toBe(N);
  });

  it('索引写入走 safeWrite 原子落盘（不退回 fs.writeFile 原地覆盖，防崩溃截断）', async () => {
    const spy = vi.spyOn(safeWriteMod, 'safeWrite');
    try {
      const { writeIndex, upsertIndexEntry } = await import('../../electron/main/memory/store');
      const { memoryIndexPath } = await import('../../electron/main/memory/paths');
      const ATOMIC_OWNER = 'atomic-index-owner';
      const idxPath = memoryIndexPath(ATOMIC_OWNER);

      await writeIndex(ATOMIC_OWNER, []);
      await upsertIndexEntry(ATOMIC_OWNER, { relPath: 'x.md', title: 'X', scope: 'agent', tags: [] });

      // 三条写路径（writeIndex / upsert / remove）都必须经 safeWrite，而非 fs.writeFile
      expect(spy).toHaveBeenCalledWith(idxPath, expect.any(String), 'LF');
    } finally {
      spy.mockRestore();
    }
  });
});
