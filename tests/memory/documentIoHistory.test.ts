/**
 * documentIo 档案写入进 FileHistory 的验证测试（Task 1 + Task 2）
 *
 * 只验档案路径（isProfileDocRelPath=true）走统一内核后的历史语义；
 * 非档案路径（episode 等）保持原 writeMarkdownFile 落盘、无历史，不在此测。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 先设好 ORU_DIR，再 import 被测模块（paths.ts 在模块级求 userDir，必须先设）
const ORU_DIR = join(tmpdir(), `oru-test-docio-history-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 1：writeMemoryDocument 档案进 FileHistory
// ──────────────────────────────────────────────────────────────────────────────

describe('writeMemoryDocument 进 FileHistory', () => {
  it('写档案后按绝对路径 fileKey 能列到快照', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const fileHistory = await import('../../electron/main/fs/fileHistory');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-list-${Date.now()}`;
    await writeMemoryDocument(ownerId, 'user/profile.md', '# 关于你\n\n初版');
    await writeMemoryDocument(ownerId, 'user/profile.md', '# 关于你\n\n改一版');
    const abs = ensureWithinRoot(memoryRoot(ownerId), 'user/profile.md');
    const snaps = await fileHistory.list(abs);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
  });

  it('落盘文件含刷新的 last-updated frontmatter，正文不重复 frontmatter', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-fm-${Date.now()}`;
    // 模型可能误带 frontmatter，write 应剥离后刷新 last-updated
    await writeMemoryDocument(ownerId, 'user/profile.md', '---\nlast-updated: 2000-01-01\n---\n正文体');
    const abs = ensureWithinRoot(memoryRoot(ownerId), 'user/profile.md');
    const raw = await fs.readFile(abs, 'utf-8');
    expect(raw).toContain('last-updated:');
    expect(raw).not.toContain('2000-01-01');
    // 只有一对 ---（frontmatter 块）：分割后恰好 3 段（before/yaml/after）
    expect(raw.split('---').length).toBe(3);
  });

  it('agents/twin/self.md 也是档案，两次写后能列到快照', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const fileHistory = await import('../../electron/main/fs/fileHistory');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-self-${Date.now()}`;
    await writeMemoryDocument(ownerId, 'agents/twin/self.md', '# 自我认知\n\n初版');
    // 再写一次，第一次落盘版应该被 guardOverwrite 兜进历史
    await writeMemoryDocument(ownerId, 'agents/twin/self.md', '# 自我认知\n\n第二版');
    const abs = ensureWithinRoot(memoryRoot(ownerId), 'agents/twin/self.md');
    const snaps = await fileHistory.list(abs);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 2：空写守卫回归 + editMemoryDocument 同代理
// ──────────────────────────────────────────────────────────────────────────────

describe('空写守卫回归', () => {
  it('空内容不覆盖非空档案（守卫保留）', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const ownerId = `h-guard-${Date.now()}`;
    await writeMemoryDocument(ownerId, 'user/profile.md', '有内容');
    await expect(writeMemoryDocument(ownerId, 'user/profile.md', '   ')).rejects.toThrow();
  });
});

describe('editMemoryDocument 进 FileHistory', () => {
  it('唯一匹配替换后也进历史', async () => {
    const { writeMemoryDocument, editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const fileHistory = await import('../../electron/main/fs/fileHistory');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-edit-${Date.now()}`;
    await writeMemoryDocument(ownerId, 'agents/twin/self.md', '# 自己\n\n旧句子');
    const res = await editMemoryDocument(ownerId, 'agents/twin/self.md', '旧句子', '新句子');
    expect(res.replaced).toBe(true);
    const abs = ensureWithinRoot(memoryRoot(ownerId), 'agents/twin/self.md');
    const raw = await fs.readFile(abs, 'utf-8');
    expect(raw).toContain('新句子');
    const snaps = await fileHistory.list(abs);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
  });

  it('0 次命中不写盘、不新增历史（命中判定在 commitWorkfileEdit 之外）', async () => {
    const { writeMemoryDocument, editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const fileHistory = await import('../../electron/main/fs/fileHistory');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-none-${Date.now()}`;
    await writeMemoryDocument(ownerId, 'agents/twin/self.md', '# 自己\n\n有内容'); // by:'user'
    const abs = ensureWithinRoot(memoryRoot(ownerId), 'agents/twin/self.md');
    const before = (await fileHistory.list(abs)).length;
    const res = await editMemoryDocument(ownerId, 'agents/twin/self.md', '不存在的句子', 'X');
    expect(res.replaced).toBe(false);
    expect(res.reason).toBe('none');
    // 无新增快照＝没走进 commitWorkfileEdit 锁写盘（否则会 guardOverwrite 推 lastAuthor='ai' + snapshot）
    expect((await fileHistory.list(abs)).length).toBe(before);
  });

  it('多次命中不写盘、不新增历史', async () => {
    const { writeMemoryDocument, editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const fileHistory = await import('../../electron/main/fs/fileHistory');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-multi-${Date.now()}`;
    await writeMemoryDocument(ownerId, 'agents/twin/self.md', '# 自己\n\n重复 重复');
    const abs = ensureWithinRoot(memoryRoot(ownerId), 'agents/twin/self.md');
    const before = (await fileHistory.list(abs)).length;
    const res = await editMemoryDocument(ownerId, 'agents/twin/self.md', '重复', 'X');
    expect(res.replaced).toBe(false);
    expect(res.reason).toBe('multiple');
    expect((await fileHistory.list(abs)).length).toBe(before);
  });
});

describe('非档案路径不进历史（原行为保留）', () => {
  it('episode 路径走 writeMarkdownFile，不进 FileHistory', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const fileHistory = await import('../../electron/main/fs/fileHistory');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-ep-${Date.now()}`;
    const epPath = 'agents/twin/episodes/2026-01-01-test.md';
    await writeMemoryDocument(ownerId, epPath, '# 事件正文\n');
    const abs = ensureWithinRoot(memoryRoot(ownerId), epPath);
    const snaps = await fileHistory.list(abs);
    // episode 走 writeMarkdownFile，不进 FileHistory（snaps 应为空）
    expect(snaps.length).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 5：并发不丢更新回归（C2 验证目标）
// ──────────────────────────────────────────────────────────────────────────────

describe('并发不丢更新回归（C2）', () => {
  it('用户写与 AI 写并发不互相吞（同一把 runExclusive 锁）', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const fileHistory = await import('../../electron/main/fs/fileHistory');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-c2-${Date.now()}`;
    await writeMemoryDocument(ownerId, 'user/profile.md', '# 关于你\n\n基线');
    await Promise.all([
      writeMemoryDocument(ownerId, 'user/profile.md', '# 关于你\n\n基线\n\n用户加的段', { by: 'user' }),
      writeMemoryDocument(ownerId, 'user/profile.md', '# 关于你\n\n基线\n\nAI 加的段', { by: 'ai', mark: 'ai' }),
    ]);
    const abs = ensureWithinRoot(memoryRoot(ownerId), 'user/profile.md');
    const raw = await fs.readFile(abs, 'utf8');
    const snaps = await fileHistory.list(abs);
    // 两版都留痕、无静默丢更新：一把锁串行保证两次写都进了历史
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    // 最终态是 last-writer 之一（不是乱码/空文件）
    expect(raw).toMatch(/用户加的段|AI 加的段/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 6：dream 写回自动进历史（AI 笔快照 kind 验证）
// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// 回归：档案「完成」留底不因 autosave 已把内容落定磁盘而丢失（版本记录不正确的病根）
// ──────────────────────────────────────────────────────────────────────────────

describe('「完成」manual 留底在内容已 settle 到磁盘后仍可见', () => {
  it('autosave 落定内容后再 mark:manual，listForUser 应含一条 manual', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const fileHistory = await import('../../electron/main/fs/fileHistory');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-manual-settle-${Date.now()}`;
    const rel = 'user/profile.md';
    await writeMemoryDocument(ownerId, rel, '# 关于你\n\n初版'); // 打开基线
    await writeMemoryDocument(ownerId, rel, '# 关于你\n\n最终内容'); // 编辑期 autosave（无 mark）落定磁盘
    await writeMemoryDocument(ownerId, rel, '# 关于你\n\n最终内容', { mark: 'manual' }); // 点「完成」，同字节
    const abs = ensureWithinRoot(memoryRoot(ownerId), rel);
    const visible = await fileHistory.listForUser(abs);
    expect(visible.some((s) => s.kind === 'manual')).toBe(true);
  });
});

describe('AI 笔写档案进历史且快照 kind 含 ai', () => {
  it('以 {by:ai, mark:ai} 写档案后快照列表中有 kind===ai 的条目', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const fileHistory = await import('../../electron/main/fs/fileHistory');
    const { ensureWithinRoot } = await import('../../electron/main/fs/frontmatter');

    const ownerId = `h-ai-kind-${Date.now()}`;
    await writeMemoryDocument(ownerId, 'user/profile.md', '# 关于你\n\nv1', { by: 'user' });
    await writeMemoryDocument(ownerId, 'user/profile.md', '# 关于你\n\nv2-AI补充', { by: 'ai', mark: 'ai' });
    const abs = ensureWithinRoot(memoryRoot(ownerId), 'user/profile.md');
    const snaps = await fileHistory.list(abs);
    // commitWorkfileWrite(mark:'ai') 会调 fileHistory.snapshot(key,'ai',content)，故应有 kind==='ai' 快照
    expect(snaps.some((s) => s.kind === 'ai')).toBe(true);
  });
});
