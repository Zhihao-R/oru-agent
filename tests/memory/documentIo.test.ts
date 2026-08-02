/**
 * documentIo.ts 单测 —— 档案的通用「写整篇 / 改一段」核心（与对话文件工具对齐）
 *
 * write/edit_memory 工具的底座：整篇覆盖正文（frontmatter 系统保留/更新）、
 * 正文内唯一精确匹配替换（0/多次不写盘、让模型重试）、沙箱越界、RMW 入锁防并发丢更新。
 * 设计见 docs/tech/2026-06-27-memory-document-model-tech-design.md §2 / §4。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-docio-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

async function readRaw(ownerId: string, relPath: string): Promise<string> {
  const { memoryRoot } = await import('../../electron/main/memory/paths');
  return fs.readFile(join(memoryRoot(ownerId), relPath), 'utf-8');
}

describe('writeMemoryDocument 整篇覆盖正文', () => {
  it('写新文件：正文落盘，frontmatter 自带 last-updated', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `w-new-${Date.now()}`;
    await writeMemoryDocument(owner, 'user/profile.md', '整体印象。\n\n## 事实\n- 现居成都');
    const raw = await readRaw(owner, 'user/profile.md');
    expect(raw).toContain('整体印象。');
    expect(raw).toContain('## 事实');
    expect(raw).toMatch(/last-updated:/);
  });

  it('覆盖：保留已有 frontmatter 其它字段、刷新 last-updated、正文整替', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { memoryRoot } = await import('../../electron/main/memory/paths');
    const owner = `w-over-${Date.now()}`;
    const abs = join(memoryRoot(owner), 'user/profile.md');
    await fs.mkdir(join(memoryRoot(owner), 'user'), { recursive: true });
    await fs.writeFile(abs, '---\ncreated: 2020-01-01\nlast-updated: 2020-01-01\n---\n旧正文\n');
    await writeMemoryDocument(owner, 'user/profile.md', '新正文');
    const raw = await fs.readFile(abs, 'utf-8');
    expect(raw).toContain('created: 2020-01-01'); // 其它字段保留
    expect(raw).not.toContain('2020-01-01\n---'); // last-updated 已刷新（不再是旧值）
    expect(raw).toContain('新正文');
    expect(raw).not.toContain('旧正文');
  });

  it('content 误带 frontmatter → 剥离，只落正文', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `w-strip-${Date.now()}`;
    await writeMemoryDocument(owner, 'user/profile.md', '---\nfoo: bar\n---\n真正的正文');
    const raw = await readRaw(owner, 'user/profile.md');
    expect(raw).toContain('真正的正文');
    expect(raw).not.toContain('foo: bar');
  });

  it('relPath 越界沙箱 → 抛错', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `w-escape-${Date.now()}`;
    await expect(writeMemoryDocument(owner, '../../etc/evil.md', 'x')).rejects.toThrow();
  });

  it('档案篇幅硬上限（S35·G35）：超硬上限拦写、软预算内放行、非档案不限', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const { SNAPSHOT_BUDGET, PROFILE_HARD_LIMIT_MULTIPLIER } = await import(
      '../../electron/main/memory/snapshot'
    );
    const owner = `w-budget-${Date.now()}`;
    const userHard = SNAPSHOT_BUDGET.userProfile * PROFILE_HARD_LIMIT_MULTIPLIER;
    // 超硬上限 → 拦写
    await expect(
      writeMemoryDocument(owner, 'user/profile.md', '一'.repeat(userHard + 1)),
    ).rejects.toThrow(/篇幅超硬上限/);
    // 软预算内 → 放行
    await writeMemoryDocument(owner, 'user/profile.md', '一'.repeat(SNAPSHOT_BUDGET.userProfile));
    expect((await readRaw(owner, 'user/profile.md')).includes('一'.repeat(100))).toBe(true);
    // 非档案路径（episode）不受篇幅预算约束——即便超同等长度也能写
    await expect(
      writeMemoryDocument(owner, 'agents/twin/episodes/2026-01-01-x.md', '一'.repeat(userHard + 1)),
    ).resolves.not.toThrow();
  });

  it('防误删全损：空内容覆盖非空档案 → 抛错、原文不动（记忆文件不可逆，必须挡）', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `w-emptyguard-${Date.now()}`;
    await writeMemoryDocument(owner, 'user/profile.md', '## 事实\n- 现居成都');
    const before = await readRaw(owner, 'user/profile.md');
    await expect(writeMemoryDocument(owner, 'user/profile.md', '   \n  ')).rejects.toThrow(/空内容/);
    expect(await readRaw(owner, 'user/profile.md')).toBe(before); // 原文逐字节不动
  });

  it('空内容写新文件 / 覆盖空文件 → 允许（不是误删）', async () => {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `w-emptyok-${Date.now()}`;
    await expect(writeMemoryDocument(owner, 'user/profile.md', '')).resolves.not.toThrow();
  });
});

describe('editMemoryDocument 正文内唯一精确匹配替换', () => {
  async function seed(owner: string, body: string): Promise<void> {
    const { writeMemoryDocument } = await import('../../electron/main/memory/documentIo');
    await writeMemoryDocument(owner, 'user/profile.md', body);
  }

  it('唯一命中 → 替换并写盘', async () => {
    const { editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `e-uniq-${Date.now()}`;
    await seed(owner, '## 事实\n- 现居成都\n- 职业是工程师');
    const r = await editMemoryDocument(owner, 'user/profile.md', '- 现居成都', '- 现居杭州');
    expect(r.replaced).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.afterHash).toBeTruthy(); // 撤回锚点：记忆卡据它回滚这一次修改（memory/revert.ts）
    const raw = await readRaw(owner, 'user/profile.md');
    expect(raw).toContain('- 现居杭州');
    expect(raw).not.toContain('- 现居成都');
    expect(raw).toContain('- 职业是工程师'); // 其它行不动
  });

  it('0 命中 → 不写盘，reason=none', async () => {
    const { editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `e-none-${Date.now()}`;
    await seed(owner, '## 事实\n- 现居成都');
    const before = await readRaw(owner, 'user/profile.md');
    const r = await editMemoryDocument(owner, 'user/profile.md', '- 不存在', 'x');
    expect(r).toEqual({ replaced: false, reason: 'none' });
    expect(await readRaw(owner, 'user/profile.md')).toBe(before);
  });

  it('多命中 → 不写盘，reason=multiple（让模型给更长上下文重试）', async () => {
    const { editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `e-multi-${Date.now()}`;
    await seed(owner, '- 同一行\n- 同一行');
    const before = await readRaw(owner, 'user/profile.md');
    const r = await editMemoryDocument(owner, 'user/profile.md', '- 同一行', '- 改了');
    expect(r).toEqual({ replaced: false, reason: 'multiple' });
    expect(await readRaw(owner, 'user/profile.md')).toBe(before);
  });

  it('newText 空串 = 删除该段', async () => {
    const { editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `e-del-${Date.now()}`;
    await seed(owner, '## 事实\n- 删我\n- 留我');
    const r = await editMemoryDocument(owner, 'user/profile.md', '- 删我\n', '');
    expect(r.replaced).toBe(true);
    const raw = await readRaw(owner, 'user/profile.md');
    expect(raw).not.toContain('删我');
    expect(raw).toContain('- 留我');
  });

  it('oldText 含正则特殊字符（$ 等）按字面替换，不被当模式解释', async () => {
    const { editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `e-literal-${Date.now()}`;
    await seed(owner, '价格 $5 和 $&符号');
    const r = await editMemoryDocument(owner, 'user/profile.md', '$5', '$10');
    expect(r.replaced).toBe(true);
    expect(await readRaw(owner, 'user/profile.md')).toContain('价格 $10 和 $&符号');
  });

  it('文件不存在 → reason=none', async () => {
    const { editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `e-missing-${Date.now()}`;
    const r = await editMemoryDocument(owner, 'user/profile.md', 'x', 'y');
    expect(r).toEqual({ replaced: false, reason: 'none' });
  });

  it('relPath 越界沙箱 → 抛错', async () => {
    const { editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `e-escape-${Date.now()}`;
    await expect(editMemoryDocument(owner, '../evil.md', 'a', 'b')).rejects.toThrow();
  });

  it('并发两次 edit 撞同一文件：withFileLock 串行，两处改动都不丢', async () => {
    const { editMemoryDocument } = await import('../../electron/main/memory/documentIo');
    const owner = `e-race-${Date.now()}`;
    await seed(owner, '- A 原\n- B 原');
    await Promise.all([
      editMemoryDocument(owner, 'user/profile.md', '- A 原', '- A 新'),
      editMemoryDocument(owner, 'user/profile.md', '- B 原', '- B 新'),
    ]);
    const raw = await readRaw(owner, 'user/profile.md');
    expect(raw).toContain('- A 新');
    expect(raw).toContain('- B 新'); // 无丢更新
  });
});
