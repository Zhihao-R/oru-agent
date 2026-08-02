/**
 * S28 集成测试：换笔覆盖可见（G91）、旁路写入可见标记（G39）、历史时间轴随改名/移动迁移（G93）。
 * 走真实 fs（ORU_DIR 重定向 + 动态 import），验证从落盘临界区到历史窗口列表的端到端行为。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-s28-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const PROJECT = join(ORU_DIR, 'project');

let FH!: typeof import('../../electron/main/fs/fileHistory');
let commitWorkfileWrite!: typeof import('../../electron/main/fs/workfileWrite').commitWorkfileWrite;
let applyTextEdit!: typeof import('../../electron/main/fs/applyTextEdit').applyTextEdit;

let seq = 0;
function freshFile(): string {
  return join(PROJECT, `wf-${seq++}.md`);
}

beforeAll(async () => {
  await fs.mkdir(PROJECT, { recursive: true });
  FH = await import('../../electron/main/fs/fileHistory');
  ({ commitWorkfileWrite } = await import('../../electron/main/fs/workfileWrite'));
  ({ applyTextEdit } = await import('../../electron/main/fs/applyTextEdit'));
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

async function visibleKinds(fileKey: string): Promise<string[]> {
  return (await FH.listForUser(fileKey)).map((s) => s.kind);
}

describe('S28 · G91 换笔覆盖可见可点回', () => {
  it('用户自动保存（无手动标）后被 AI 覆盖：你的最后一版打可见 handoff 标、可点回', async () => {
    const p = freshFile();
    // 用户自动保存（无 mark）——磁盘=userV1，不进可见历史（这正是以前找不回的场景）
    await commitWorkfileWrite({ absPath: p, content: 'userV1', by: 'user' });
    // AI 覆盖——换笔，把 userV1 兜成可见 handoff
    await commitWorkfileWrite({ absPath: p, content: 'aiV2', by: 'ai', mark: 'ai' });

    const visible = await FH.listForUser(resolve(p));
    const handoff = visible.find((s) => s.kind === 'handoff');
    expect(handoff).toBeDefined();
    expect(await FH.restore(resolve(p), handoff!.id)).toBe('userV1'); // 点得回你的最后一版
  });

  it('同一支笔连续自动保存：中间版走隐藏 overwrite-guard，不刷屏历史窗口', async () => {
    const p = freshFile();
    await commitWorkfileWrite({ absPath: p, content: 'u1', by: 'user' });
    await commitWorkfileWrite({ absPath: p, content: 'u2', by: 'user' });
    await commitWorkfileWrite({ absPath: p, content: 'u3', by: 'user' });
    // 同笔覆盖不产生 handoff（否则每次自动保存都上屏）
    expect(await visibleKinds(resolve(p))).not.toContain('handoff');
  });

  it('AI 局部编辑覆盖用户版：你的版本打可见 handoff（commitWorkfileEdit 路径）', async () => {
    const p = freshFile();
    const { commitWorkfileEdit } = await import('../../electron/main/fs/workfileWrite');
    await commitWorkfileWrite({ absPath: p, content: 'line-you', by: 'user' }); // 用户自动保存
    await commitWorkfileEdit({ absPath: p, apply: (c) => `${c}\nline-ai`, mark: 'ai' }); // AI 追加
    const visible = await FH.listForUser(resolve(p));
    const handoff = visible.find((s) => s.kind === 'handoff');
    expect(handoff).toBeDefined();
    expect(await FH.restore(resolve(p), handoff!.id)).toBe('line-you');
  });

  it('恢复旧版后用户再编辑：不产生虚假 handoff（恢复是用户动作，lastAuthor 记为 user）', async () => {
    const { restoreWorkfileSnapshot } = await import('../../electron/main/fs/workfileWrite');
    const p = freshFile();
    await fs.writeFile(p, 'seed', 'utf-8');
    // 用户先存一版（拿到可恢复的 snapshotId），再 AI 覆盖（lastAuthor→ai）
    await commitWorkfileWrite({ absPath: p, content: 'userVersion', by: 'user', mark: 'manual' });
    const userSnap = (await FH.listForUser(resolve(p))).find((s) => s.kind === 'manual')!;
    await commitWorkfileWrite({ absPath: p, content: 'aiVersion', by: 'ai', mark: 'ai' });
    // 用户恢复到自己那版（恢复动作把磁盘作者置回 user）
    await restoreWorkfileSnapshot(p, userSnap.id);
    const beforeEdit = (await FH.listForUser(resolve(p))).filter((s) => s.kind === 'handoff').length;
    // 用户随后自己编辑保存——同笔（user 覆盖 user 刚恢复的版本），不该冒出新 handoff
    await commitWorkfileWrite({ absPath: p, content: 'userEditAfterRestore', by: 'user' });
    const afterEdit = (await FH.listForUser(resolve(p))).filter((s) => s.kind === 'handoff').length;
    expect(afterEdit).toBe(beforeEdit); // 无虚假 handoff
  });

  it('guardOverwrite 首见（无已知作者）不臆断换笔——打隐藏 overwrite-guard', async () => {
    const p = freshFile();
    // 磁盘先有内容但历史无作者记录（如迁移前老文件）；首次覆盖 lastAuthor 未知，不判换笔
    await FH.guardOverwrite(resolve(p), 'legacy', 'ai');
    expect(await visibleKinds(resolve(p))).not.toContain('handoff');
  });
});

describe('S28 · G39 旁路写入（预览右键改字）可见标记', () => {
  it('applyTextEdit 带 visibleMark：新内容留可见标，时间轴认得出、点得回', async () => {
    const p = join(PROJECT, 'preview.html');
    await fs.writeFile(p, '<p>orig</p>', 'utf-8');
    // 模拟 fs.applyTextEdit handler：by=user + visibleMark=manual
    const r = await applyTextEdit({ filePath: p, oldText: 'orig', newText: 'edited', by: 'user', visibleMark: 'manual' });
    expect(r.ok).toBe(true);
    const visible = await FH.listForUser(resolve(p));
    // 新内容 <p>edited</p> 以 manual 标进可见历史
    const marked = visible.find((s) => s.kind === 'manual');
    expect(marked).toBeDefined();
    expect(await FH.restore(resolve(p), marked!.id)).toBe('<p>edited</p>');
  });

  it('applyTextEdit 不传 visibleMark（deck 壳路径）：新内容不打可见标（deck 另有 inline 提交）', async () => {
    const p = join(PROJECT, 'deck-like.html');
    await fs.writeFile(p, '<p>d0</p>', 'utf-8');
    await applyTextEdit({ filePath: p, oldText: 'd0', newText: 'd1' }); // deck 壳：不传 by/visibleMark
    expect(await visibleKinds(resolve(p))).not.toContain('manual');
  });
});

describe('S28 · G92 里程碑到期归档发系统信号（接线）', () => {
  /** 找某 fileKey 的 manifest.json 路径（历史目录按 sha256 寻址，直接从盘上找唯一 manifest）。 */
  async function manifestPathOf(fileKey: string): Promise<string> {
    await FH.snapshot(fileKey, 'manual', '__probe__'); // 先落一版逼出目录
    // 遍历 history 根找含本 fileKey 的 manifest
    const { createHash } = await import('node:crypto');
    const slug = createHash('sha256').update(fileKey, 'utf-8').digest('hex').slice(0, 32);
    return join(ORU_DIR, 'users', 'local-user', 'history', slug, 'manifest.json');
  }

  it('里程碑超保留期时归档、触发 archivalListener（不静默删）', async () => {
    const key = resolve(freshFile());
    await FH.snapshot(key, 'manual', 'milestone-old');
    const mPath = await manifestPathOf(key);

    // 回填该里程碑 createdAt 到超保留期
    const store = JSON.parse(await fs.readFile(mPath, 'utf-8'));
    for (const s of store.snapshots) if (s.kind === 'manual') s.createdAt = Date.now() - FH.MAX_AGE_MS - 60_000;
    await fs.writeFile(mPath, JSON.stringify(store), 'utf-8');

    const archivedCalls: number[] = [];
    FH.setArchivalListener((_k, refs) => archivedCalls.push(refs.length));
    try {
      // 触发一次写 → 跑 GC → 到期里程碑归档（不删）+ 发信号
      await FH.snapshot(key, 'periodic', 'trigger-gc');
      expect(archivedCalls.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
      // 归档的里程碑仍在、可找回（不静默删）
      const stillThere = (await FH.list(key)).some((s) => s.kind === 'manual' && s.archived);
      expect(stillThere).toBe(true);
    } finally {
      FH.setArchivalListener(null);
    }
  });
});

describe('S28 · G93 历史时间轴随改名/移动迁移', () => {
  it('relocate：旧路径的时间轴整条搬到新路径，旧路径清空', async () => {
    const oldKey = resolve(freshFile());
    const newKey = resolve(freshFile());
    await FH.snapshot(oldKey, 'manual', 'content-A');
    await FH.snapshot(oldKey, 'ai', 'content-B');
    expect(await FH.list(oldKey)).toHaveLength(2);

    await FH.relocate(oldKey, newKey);

    expect(await FH.list(oldKey)).toHaveLength(0); // 旧路径无历史
    const moved = await FH.list(newKey);
    expect(moved).toHaveLength(2); // 新路径接手整条时间轴
    expect(await FH.restore(newKey, moved[1].id)).toBe('content-B');
  });

  it('relocate 目标处有陈留孤儿历史：先清掉再搬（文件移动已保证目标无同名文件）', async () => {
    const oldKey = resolve(freshFile());
    const newKey = resolve(freshFile());
    await FH.snapshot(newKey, 'manual', 'stale-orphan'); // 目标处此前残留
    await FH.snapshot(oldKey, 'manual', 'real');
    await FH.relocate(oldKey, newKey);
    const contents = await Promise.all((await FH.list(newKey)).map((s) => FH.restore(newKey, s.id)));
    expect(contents).toEqual(['real']); // 孤儿被清、只剩迁来的
  });

  it('relocate 旧路径无历史：no-op（不抛）', async () => {
    const oldKey = resolve(freshFile());
    const newKey = resolve(freshFile());
    await expect(FH.relocate(oldKey, newKey)).resolves.toBeUndefined();
    expect(await FH.list(newKey)).toHaveLength(0);
  });
});
