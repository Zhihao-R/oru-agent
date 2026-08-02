/**
 * supersede 单元测试 — applyConflictStrikethrough + markEpisodeSuperseded + record_memory(conflictsWith)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const ORU_DIR = join(tmpdir(), `oru-test-supersede-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const OWNER = 'supersede-owner';

function ctx(): ToolContext {
  return makeToolContext({ conversationId: 'c1', agentId: 'a1', ownerId: OWNER });
}

describe('archived 路径容错（S35·G37 移档后引用仍可达）', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  async function seed(slug: string): Promise<string> {
    const { writeEpisode } = await import('../../electron/main/memory/store');
    return writeEpisode({
      ownerId: OWNER,
      scopeName: 'agent',
      scopeId: 'twin',
      slug,
      frontmatter: { scope: 'agent', tags: [], status: 'active', created: '2026-05-01', source: 'twin-auto' },
      body: `body ${slug}`,
    });
  }

  it('readPredecessor：取代方自身被移入 archived 后，仍能反查到前一版（身份路径比较，Major 1）', async () => {
    const { markEpisodeSuperseded, readPredecessor } = await import('../../electron/main/memory/store');
    const aRel = await seed('pred-a');
    const bRel = await seed('pred-b');
    const cRel = await seed('pred-c');
    // A 被 B 取代：A.superseded-by = B 的活跃路径，A 移入 archived
    await markEpisodeSuperseded(OWNER, aRel, bRel);
    // B 再被 C 取代：B 移入 archived（其路径从活跃变 archived）
    await markEpisodeSuperseded(OWNER, bRel, cRel);
    // 用 B 的 archived 路径反查前一版——身份归一后仍等于 A.superseded-by，链不断
    const bArchived = bRel.replace('/episodes/', '/episodes/archived/');
    const pred = await readPredecessor(OWNER, bArchived);
    expect(pred?.relPath).toContain('pred-a');
  });

  it('resolveToFullRelPath：传已归档 episode 的旧活跃 relPath + verifyExists → 回落命中 archived（Major 2）', async () => {
    const { markEpisodeSuperseded } = await import('../../electron/main/memory/store');
    const { resolveToFullRelPath } = await import('../../electron/main/memory/compressedPath');
    const oldRel = await seed('resolve-old');
    const newRel = await seed('resolve-new');
    await markEpisodeSuperseded(OWNER, oldRel, newRel); // oldRel 移入 archived
    // 调用方仍持旧活跃路径——verifyExists 应回落到 archived 兄弟路径，而非返回 null
    const resolved = await resolveToFullRelPath(OWNER, oldRel, true);
    expect(resolved).toContain('/episodes/archived/');
    expect(resolved).toContain('resolve-old');
  });
});

describe('applyConflictStrikethrough', () => {
  it('bullet 行加 ~~删除线~~ + （superseded 日期）', async () => {
    const { applyConflictStrikethrough } = await import(
      '../../electron/main/memory/store'
    );
    const before = '- 用户名是阮志豪\n- 家在杭州';
    const r = applyConflictStrikethrough(before, '阮志豪', '2026-04-30');
    expect(r.matched).toBe(true);
    expect(r.content).toBe('- ~~用户名是阮志豪~~ （superseded 2026-04-30）\n- 家在杭州');
  });

  it('已经划掉的行不重复划', async () => {
    const { applyConflictStrikethrough } = await import(
      '../../electron/main/memory/store'
    );
    const before = '- ~~用户名是阮志豪~~ （superseded 2026-04-29）';
    const r = applyConflictStrikethrough(before, '阮志豪', '2026-04-30');
    expect(r.matched).toBe(false);
    expect(r.content).toBe(before);
  });

  it('没匹配返回 matched=false 内容不变', async () => {
    const { applyConflictStrikethrough } = await import(
      '../../electron/main/memory/store'
    );
    const before = '- a\n- b';
    const r = applyConflictStrikethrough(before, 'not-found');
    expect(r.matched).toBe(false);
    expect(r.content).toBe(before);
  });

  it('多个匹配只划第一个', async () => {
    const { applyConflictStrikethrough } = await import(
      '../../electron/main/memory/store'
    );
    const before = '- 用 ts\n- 用 ts';
    const r = applyConflictStrikethrough(before, 'ts', '2026-04-30');
    expect(r.matched).toBe(true);
    const lines = r.content.split('\n');
    expect(lines[0]).toMatch(/~~/);
    expect(lines[1]).not.toMatch(/~~/);
  });
});

describe('markEpisodeSuperseded', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('改 frontmatter status 为 superseded + 加 superseded-by/at + 删索引', async () => {
    const { writeEpisode, upsertIndexEntry, markEpisodeSuperseded, readIndex, readEpisode } =
      await import('../../electron/main/memory/store');

    const oldRel = await writeEpisode({
      ownerId: OWNER,
      scopeName: 'agent',
      scopeId: 'twin',
      slug: 'old',
      frontmatter: {
        scope: 'agent',
        tags: ['x'],
        status: 'active',
        created: '2026-04-29',
        source: 'twin-auto',
      },
      body: 'old body',
    });
    await upsertIndexEntry(OWNER, {
      relPath: oldRel,
      title: '旧事件',
      scope: 'agent',
      tags: ['x'],
    });

    const r = await markEpisodeSuperseded(OWNER, oldRel, 'agents/twin/episodes/new.md');
    expect(r.ok).toBe(true);
    const back = await readEpisode(OWNER, oldRel);
    expect(back!.frontmatter.status).toBe('superseded');
    expect(back!.frontmatter['superseded-by']).toBe('agents/twin/episodes/new.md');
    expect(back!.frontmatter['superseded-at']).toBeDefined();
    const idx = await readIndex(OWNER);
    expect(idx.find((e) => e.relPath === oldRel)).toBeUndefined();
    // G37：标记即物理移入 archived——活跃路径已空，archived 兄弟路径出现，readEpisode 回落命中它
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    await expect(fs.access(join(memoryRoot(OWNER), oldRel))).rejects.toThrow();
    expect(back!.relPath).toContain('/episodes/archived/');
  });

  it('文件不存在返回 ok=false', async () => {
    const { markEpisodeSuperseded } = await import(
      '../../electron/main/memory/store'
    );
    const r = await markEpisodeSuperseded(
      OWNER,
      'agents/twin/episodes/nonexistent.md',
      'new.md',
    );
    expect(r.ok).toBe(false);
  });
});

describe('applyConflictDeletion', () => {
  it('找到匹配行真删——长度减 1', async () => {
    const { applyConflictDeletion } = await import('../../electron/main/memory/store');
    const before = '- 用 ts\n- 家在杭州\n- PM 5 年';
    const r = applyConflictDeletion(before, '用 ts');
    expect(r.matched).toBe(true);
    expect(r.content.split('\n').length).toBe(2);
    expect(r.content).not.toContain('用 ts');
    expect(r.content).toContain('家在杭州');
  });

  it('已划掉的行跳过——错记不应该重复处理已 supersede 的内容', async () => {
    const { applyConflictDeletion } = await import('../../electron/main/memory/store');
    const before = '- ~~阮志豪~~ （superseded ...）\n- 阮治豪';
    const r = applyConflictDeletion(before, '阮志豪');
    expect(r.matched).toBe(false);
    expect(r.content).toBe(before);
  });

  it('没匹配返回 matched=false', async () => {
    const { applyConflictDeletion } = await import('../../electron/main/memory/store');
    const r = applyConflictDeletion('- a', 'not-found');
    expect(r.matched).toBe(false);
  });
});

describe('record_memory with conflictType=correction (v2)', () => {
  afterEach(async () => {
    const { __resetForTest } = await import('../../electron/main/memory/accessLog');
    __resetForTest();
  });

  // 注：fact（user-basic）的 correction/evolution 冲突路径随 record_memory 收成 episode-only 退役——
  // 用户画像改用 write/edit_memory 维护，冲突交给模型读后改（见 documentIo.test）。这里只留 episode 冲突。

  it('episode + correction + 旧文件不存在 → 报错（避免新旧并存）', async () => {
    const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
    const tool = __makeRecordMemoryTool();
    const r = await tool.execute(
      {
        scope: 'agent',
        type: 'episode',
        content: 'whatever',
        title: '新事件',
        slug: 'no-old',
        episodeCategory: 'agent',
        description: '验证 correction 找不到旧文件时拒绝',
        conflictsWith: 'agents/twin/episodes/2099-01-01-nonexistent.md',
        conflictType: 'correction',
        evidence: '用户当场说记错了', // G68：correction 必附依据，才走到"旧文件不存在"这一步
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/不存在/);
  });

  it('episode + correction → 旧文件移到 trash', async () => {
    const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
    const { writeEpisode, upsertIndexEntry } = await import(
      '../../electron/main/memory/store'
    );
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const oldRel = await writeEpisode({
      ownerId: OWNER,
      scopeName: 'agent',
      scopeId: 'twin',
      slug: 'wrong-event',
      frontmatter: {
        scope: 'agent',
        tags: [],
        status: 'active',
        created: '2026-04-30',
        source: 'twin-auto',
      },
      body: 'mistakenly recorded',
    });
    await upsertIndexEntry(OWNER, {
      relPath: oldRel,
      title: '错记的事件',
      scope: 'agent',
      tags: [],
    });

    const tool = __makeRecordMemoryTool();
    const r = await tool.execute(
      {
        scope: 'agent',
        type: 'episode',
        content: 'correct version',
        title: '正确版',
        slug: 'correct-event',
        episodeCategory: 'agent',
        description: '事件 correction 测试',
        conflictsWith: oldRel, // 完整 relPath（应该被 resolveOldEpisodePath 兼容）
        conflictType: 'correction',
        evidence: '用户当场说记错了，应该是 correct version', // G68：correction 强制附依据
      },
      ctx(),
    );
    expect(r.isError).not.toBe(true);
    expect(r.text).toContain('已删');
    expect(existsSync(join(memoryRoot(OWNER), oldRel))).toBe(false);
  });
});

describe('record_memory with conflictsWith (v2)', () => {
  afterEach(async () => {
    const { __resetForTest } = await import('../../electron/main/memory/accessLog');
    __resetForTest();
  });

  // fact（user-basic）的 conflictsWith 路径随 record_memory 收成 episode-only 退役（见上注）。

  it('episode + conflictsWith → 旧事件 status 改 superseded', async () => {
    const { __makeRecordMemoryTool } = await import('../../electron/main/memory/tools');
    const { writeEpisode, upsertIndexEntry, readEpisode } = await import(
      '../../electron/main/memory/store'
    );

    const oldRel = await writeEpisode({
      ownerId: OWNER,
      scopeName: 'agent',
      scopeId: 'twin',
      slug: 'thinking-old',
      frontmatter: {
        scope: 'agent',
        tags: [],
        status: 'active',
        created: '2026-04-29',
        source: 'twin-auto',
      },
      body: 'old',
    });
    await upsertIndexEntry(OWNER, {
      relPath: oldRel,
      title: '旧',
      scope: 'agent',
      tags: [],
    });

    const tool = __makeRecordMemoryTool();
    const r = await tool.execute(
      {
        scope: 'agent',
        type: 'episode',
        content: 'new body',
        title: '新',
        slug: 'thinking-new',
        episodeCategory: 'agent',
        description: 'episode supersede 测试',
        conflictsWith: oldRel, // 完整 relPath，应该被 resolveOldEpisodePath 兼容
      },
      ctx(),
    );
    expect(r.isError).not.toBe(true);
    expect(r.text).toContain('已 supersede');

    const old = await readEpisode(OWNER, oldRel);
    expect(old!.frontmatter.status).toBe('superseded');
  });
});
