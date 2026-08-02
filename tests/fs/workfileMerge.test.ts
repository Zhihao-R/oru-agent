/**
 * S27 · G87 锁内机械合并与撞同段弃写（C1 时序回归）。
 *
 * 编辑器带 baseline+mergeOnStale 的 flush 排在 AI 写之后 → 锁内 disk!==baseline：
 *  - 不同段 → 返回 merged 且合并产物含双方改动、AI 版不丢（且被兜进历史）；
 *  - 同段撞笔 → 返回 discarded 且磁盘一字未动。
 * 直测 commitWorkfileWrite 的两态形状与 diff3 调用口径；不传 mergeOnStale 的调用方行为零变化。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-workfilemerge-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const PROJECT = join(ORU_DIR, 'project');

let commitWorkfileWrite!: typeof import('../../electron/main/fs/workfileWrite').commitWorkfileWrite;
let recordDiscardedContent!: typeof import('../../electron/main/fs/workfileWrite').recordDiscardedContent;
let FH!: typeof import('../../electron/main/fs/fileHistory');

beforeAll(async () => {
  await fs.mkdir(PROJECT, { recursive: true });
  ({ commitWorkfileWrite, recordDiscardedContent } = await import('../../electron/main/fs/workfileWrite'));
  FH = await import('../../electron/main/fs/fileHistory');
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

const BASE = 'L1\nL2\nL3\n';

describe('G87 锁内机械合并', () => {
  it('不同段：AI 先落盘、编辑器带旧 base 的 flush 后到 → 合并含双方改动、AI 版不丢', async () => {
    const p = join(PROJECT, 'diff-seg.md');
    // 共同起点：编辑器读到 BASE 作 base
    await commitWorkfileWrite({ absPath: p, content: BASE });
    // AI 改了 L3（磁盘现状 = theirs）
    const theirs = 'L1\nL2\nT3\n';
    await commitWorkfileWrite({ absPath: p, content: theirs });
    // 编辑器基于旧 base 改了 L1，flush 后到，带 baseline+mergeOnStale
    const mine = 'M1\nL2\nL3\n';
    const res = await commitWorkfileWrite({
      absPath: p,
      content: mine,
      baseline: { content: BASE },
      mergeOnStale: true,
      mark: 'manual',
    });
    expect(res.status).toBe('merged');
    if (res.status !== 'merged') throw new Error('unreachable');
    expect(res.content).toBe('M1\nL2\nT3\n'); // 双方改动都在
    expect(await fs.readFile(p, 'utf-8')).toBe('M1\nL2\nT3\n'); // 磁盘 = 合并产物
    // AI 落的 theirs 版在被合并覆盖前进了历史（不丢）
    const hist = await FH.list(p);
    expect(hist.some((s) => s.kind === 'overwrite-guard')).toBe(true);
  });

  it('撞同段：返回 discarded 且磁盘一字未动（AI 版保留）', async () => {
    const p = join(PROJECT, 'same-seg.md');
    await commitWorkfileWrite({ absPath: p, content: BASE });
    const theirs = 'L1\nT2\nL3\n'; // AI 改 L2
    await commitWorkfileWrite({ absPath: p, content: theirs });
    const mine = 'L1\nM2\nL3\n'; // 编辑器也改 L2（同段、不同值）
    const res = await commitWorkfileWrite({
      absPath: p,
      content: mine,
      baseline: { content: BASE },
      mergeOnStale: true,
    });
    expect(res).toEqual({ status: 'rejected', reason: 'discarded' });
    expect(await fs.readFile(p, 'utf-8')).toBe(theirs); // 一字未动
  });

  it('基线未过期（disk===baseline）：mergeOnStale 也走普通写、返回 written', async () => {
    const p = join(PROJECT, 'fresh.md');
    await commitWorkfileWrite({ absPath: p, content: BASE });
    const mine = 'M1\nL2\nL3\n';
    const res = await commitWorkfileWrite({
      absPath: p,
      content: mine,
      baseline: { content: BASE },
      mergeOnStale: true,
    });
    expect(res.status).toBe('written');
    expect(await fs.readFile(p, 'utf-8')).toBe(mine);
  });

  it('不传 mergeOnStale：基线过期照旧 baseline-mismatch（AI 口径零变化）', async () => {
    const p = join(PROJECT, 'ai.md');
    await commitWorkfileWrite({ absPath: p, content: BASE });
    await commitWorkfileWrite({ absPath: p, content: 'L1\nL2\nT3\n' }); // 磁盘已变
    const res = await commitWorkfileWrite({
      absPath: p,
      content: 'M1\nL2\nL3\n',
      baseline: { content: BASE },
    });
    expect(res).toEqual({ status: 'rejected', reason: 'baseline-mismatch' });
  });
});

describe('弃写降级入历史（S27 交付接口，S29 触发）', () => {
  it('recordDiscardedContent 写一条 discarded 快照：可找回（进 USER_VISIBLE）、不碰磁盘', async () => {
    const p = join(PROJECT, 'discarded.md');
    await commitWorkfileWrite({ absPath: p, content: BASE });
    await recordDiscardedContent(p, '用户在途没接住的内容\n');
    expect(await fs.readFile(p, 'utf-8')).toBe(BASE); // 只加历史、不碰磁盘文件
    const visible = await FH.listForUser(p);
    expect(visible.some((s) => s.kind === 'discarded')).toBe(true); // 用户可见、点得回
  });
});
