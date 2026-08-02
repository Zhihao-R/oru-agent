/**
 * 档案记忆「撤回这次修改」的定位（memory/revert.ts）
 *
 * 修前的缺陷：memory.undo 一律 moveToTrash(memoryRoot/relPath)，对档案类卡片（relPath =
 * user/profile.md）等于把整份用户画像挪进回收站——确认框却只说"撤销这条记忆：<那一句>"。
 * 档案里没有可整体移走的「这条记忆」，撤回只能是「回到这次写入之前那一版」。
 *
 * 这里验的是那个定位算得对不对，以及什么时候必须拒绝——错撤比撤不了严重得多。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryRecordPayload } from '@shared/types';

// 先设好 ORU_DIR，再 import 被测模块（paths.ts 在模块级求 userDir，必须先设）
const ORU_DIR = join(tmpdir(), `oru-test-memory-revert-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const REL = 'user/profile.md';

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

async function profileAbs(ownerId: string): Promise<string> {
  const { memoryRoot } = await import('../../electron/main/memory/paths');
  const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');
  return ensureWithinRoot(memoryRoot(ownerId), REL);
}

describe('resolveRevertTarget', () => {
  it('改一段后撤回 → 回到改之前那一版，整份档案还在（不是挪进回收站）', async () => {
    const { writeMemoryDocument, editMemoryDocument } = await import(
      '../../electron/main/memory/documentIo'
    );
    const { resolveRevertTarget } = await import('../../electron/main/memory/revert');
    const { restoreWorkfileSnapshot } = await import('../../electron/main/fs/workfileWrite');
    const { readMarkdownFile } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `revert-basic-${Date.now()}`;
    await writeMemoryDocument(ownerId, REL, '# 关于你\n\n称呼：阮子\n\n## 作息\n晚睡', {
      by: 'ai',
      mark: 'ai',
    });
    const edit = await editMemoryDocument(ownerId, REL, '称呼：阮子', '称呼：阮子，男，硕士');
    expect(edit.replaced).toBe(true);
    expect(edit.afterHash).toBeTruthy();

    const abs = await profileAbs(ownerId);
    const target = await resolveRevertTarget(abs, edit.afterHash!);
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    await restoreWorkfileSnapshot(abs, target.snapshotId);
    const after = await readMarkdownFile(abs);
    // 档案还在，且回到了改之前——别的小节一并保住
    expect(after).not.toBeNull();
    expect(after!.content).toContain('称呼：阮子');
    expect(after!.content).not.toContain('男，硕士');
    expect(after!.content).toContain('## 作息');
  });

  it('这次写入之后档案又被改过 → 拒绝，不能连带抹掉后来的改动', async () => {
    const { writeMemoryDocument, editMemoryDocument } = await import(
      '../../electron/main/memory/documentIo'
    );
    const { resolveRevertTarget } = await import('../../electron/main/memory/revert');

    const ownerId = `revert-stale-${Date.now()}`;
    await writeMemoryDocument(ownerId, REL, '# 关于你\n\n第一版', { by: 'ai', mark: 'ai' });
    const first = await editMemoryDocument(ownerId, REL, '第一版', '第二版');
    // 第二次修改：第一张卡的撤回从此不再成立
    await editMemoryDocument(ownerId, REL, '第二版', '第三版');

    const target = await resolveRevertTarget(await profileAbs(ownerId), first.afterHash!);
    expect(target).toEqual({ ok: false, reason: 'changed-since' });
  });

  it('最近一次修改仍可撤回（前一条的存在不挡后一条）', async () => {
    const { writeMemoryDocument, editMemoryDocument } = await import(
      '../../electron/main/memory/documentIo'
    );
    const { resolveRevertTarget } = await import('../../electron/main/memory/revert');

    const ownerId = `revert-latest-${Date.now()}`;
    await writeMemoryDocument(ownerId, REL, '# 关于你\n\nA', { by: 'ai', mark: 'ai' });
    await editMemoryDocument(ownerId, REL, 'A', 'B');
    const last = await editMemoryDocument(ownerId, REL, 'B', 'C');

    const target = await resolveRevertTarget(await profileAbs(ownerId), last.afterHash!);
    expect(target.ok).toBe(true);
  });

  it('内容绕回过同一字面（A→B→C→B）→ 拒绝，绝不恢复成用户没见过的中间态', async () => {
    // hash 只能证明「当下内容等于某次写入的字面」，不能证明中间没改过又改回来。取「最近那条同 hash」
    // 会把档案恢复成 C——用户点的是「回到 A」。认不准就不撤。
    const { writeMemoryDocument, editMemoryDocument } = await import(
      '../../electron/main/memory/documentIo'
    );
    const { resolveRevertTarget } = await import('../../electron/main/memory/revert');

    const ownerId = `revert-cycle-${Date.now()}`;
    await writeMemoryDocument(ownerId, REL, '# 关于你\n\nA', { by: 'ai', mark: 'ai' });
    const toB = await editMemoryDocument(ownerId, REL, 'A', 'B'); // 用户手上这张卡：期望撤回后是 A
    await editMemoryDocument(ownerId, REL, 'B', 'C');
    await editMemoryDocument(ownerId, REL, 'C', 'B'); // 绕回同一字面

    const target = await resolveRevertTarget(await profileAbs(ownerId), toB.afterHash!);
    expect(target).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('校验通过后档案又被写了一次 → 锁内重判拦下，一字不改', async () => {
    // 锁外算出的「可以撤」跨过 await 就可能过期（CLAUDE.md·并发）；承重判断锁内重做。
    const { writeMemoryDocument, editMemoryDocument } = await import(
      '../../electron/main/memory/documentIo'
    );
    const { resolveRevertTarget } = await import('../../electron/main/memory/revert');
    const { restoreWorkfileSnapshot } = await import('../../electron/main/fs/workfileWrite');
    const { readMarkdownFile } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `revert-toctou-${Date.now()}`;
    await writeMemoryDocument(ownerId, REL, '# 关于你\n\n第一版', { by: 'ai', mark: 'ai' });
    const edit = await editMemoryDocument(ownerId, REL, '第一版', '第二版');
    const abs = await profileAbs(ownerId);
    const target = await resolveRevertTarget(abs, edit.afterHash!);
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    // 校验之后、执行之前，别的写者又落了一版
    await editMemoryDocument(ownerId, REL, '第二版', '第三版');

    await expect(
      restoreWorkfileSnapshot(abs, target.snapshotId, { expectCurrentHash: edit.afterHash! }),
    ).rejects.toMatchObject({ code: 'WORKFILE_RESTORE_STALE' });
    // 磁盘一字未动——后来的改动还在
    expect((await readMarkdownFile(abs))!.content).toContain('第三版');
  });

  it('历史里找不到那一版（已过保留期被 GC）→ 拒绝而非乱回滚', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { resolveRevertTarget } = await import('../../electron/main/memory/revert');
    const fileHistory = await import('../../electron/main/fs/fileHistory');

    const ownerId = `revert-gc-${Date.now()}`;
    const res = await writeMemoryDocument(ownerId, REL, '# 关于你\n\n只此一版', {
      by: 'ai',
      mark: 'ai',
    });
    const abs = await profileAbs(ownerId);
    await fileHistory.clear(abs); // 模拟历史已被 GC / 用户清空

    const target = await resolveRevertTarget(abs, res.afterHash!);
    expect(target.ok).toBe(false);
    if (target.ok) return;
    expect(target.reason).toBe('history-gone');
  });
});

describe('产卡 payload', () => {
  it('edit_memory 带上被替换掉的原文与撤回锚点——卡片才能显示「改了什么」', async () => {
    const { createMemoryTools } = await import('../../electron/main/memory/tools');
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { makeToolContext } = await import('../helpers/toolContext');

    const ownerId = `card-edit-${Date.now()}`;
    await writeMemoryDocument(ownerId, REL, '# 关于你\n\n称呼：阮子', { by: 'ai', mark: 'ai' });

    const cards: MemoryRecordPayload[] = [];
    const editTool = createMemoryTools().find((tool) => tool.name === 'edit_memory');
    expect(editTool).toBeTruthy();
    await editTool!.execute(
      { relPath: REL, oldText: '称呼：阮子', newText: '称呼：阮子，男' },
      makeToolContext({
        ownerId,
        onMemoryRecord: async (p) => {
          cards.push(p);
        },
      }),
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].replaced).toBe('称呼：阮子');
    expect(cards[0].preview).toBe('称呼：阮子，男');
    expect(cards[0].revertHash).toBeTruthy();
  });

  it('write_memory 整篇覆盖不贴正文片段——改动可能不在开头，贴了等于误导', async () => {
    const { createMemoryTools } = await import('../../electron/main/memory/tools');
    const { makeToolContext } = await import('../helpers/toolContext');

    const ownerId = `card-write-${Date.now()}`;
    const cards: MemoryRecordPayload[] = [];
    const writeTool = createMemoryTools().find((tool) => tool.name === 'write_memory');
    expect(writeTool).toBeTruthy();
    await writeTool!.execute(
      { relPath: REL, content: '# 关于你\n\n开头这段没改\n\n## 作息\n改的是这里' },
      makeToolContext({
        ownerId,
        onMemoryRecord: async (p) => {
          cards.push(p);
        },
      }),
    );

    expect(cards).toHaveLength(1);
    expect(cards[0].preview).toBe('');
    expect(cards[0].replaced).toBeUndefined();
    expect(cards[0].revertHash).toBeTruthy();
  });

  it('整篇覆盖报出动了哪几个小节——只说「整篇重写了」等于什么都没说', async () => {
    const { createMemoryTools } = await import('../../electron/main/memory/tools');
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { makeToolContext } = await import('../helpers/toolContext');

    const ownerId = `card-sections-${Date.now()}`;
    await writeMemoryDocument(ownerId, REL, '印象\n\n## 作息\n晚睡\n\n## 工作节奏\n慢热', {
      by: 'ai',
      mark: 'ai',
    });

    const cards: MemoryRecordPayload[] = [];
    const writeTool = createMemoryTools().find((tool) => tool.name === 'write_memory');
    await writeTool!.execute(
      { relPath: REL, content: '印象\n\n## 作息\n早睡了\n\n## 饮食习惯\n不吃辣' },
      makeToolContext({
        ownerId,
        onMemoryRecord: async (p) => {
          cards.push(p);
        },
      }),
    );

    expect(cards[0].sections).toEqual({
      added: ['饮食习惯'],
      changed: ['作息'],
      removed: ['工作节奏'],
    });
  });
});
