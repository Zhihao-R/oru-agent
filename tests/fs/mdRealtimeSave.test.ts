/**
 * md 实时落盘端到端（writeMd → 统一临界区 → FileHistory），技术设计 §3.1/§11.13（md 一类）。
 *
 * 验证：①writeMd 走原子写（safeWrite）非裸 writeFile；②覆盖前 overwrite-guard 把上一版兜进历史不丢；
 * ③mark='manual' 留底；④restoreWorkfileSnapshot 恢复旧版且先留底当前。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-mdrealtime-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const PROJECT = join(ORU_DIR, 'project');

let writeMd!: typeof import('../../electron/main/fs/md').writeMd;
let readMd!: typeof import('../../electron/main/fs/md').readMd;
let FH!: typeof import('../../electron/main/fs/fileHistory');
let restoreWorkfileSnapshot!: typeof import('../../electron/main/fs/workfileWrite').restoreWorkfileSnapshot;

beforeAll(async () => {
  await fs.mkdir(PROJECT, { recursive: true });
  ({ writeMd, readMd } = await import('../../electron/main/fs/md'));
  FH = await import('../../electron/main/fs/fileHistory');
  ({ restoreWorkfileSnapshot } = await import('../../electron/main/fs/workfileWrite'));
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

const abs = (rel: string) => join(PROJECT, rel);

describe('md 实时落盘', () => {
  it('连续 writeMd：覆盖前把上一版兜进历史，磁盘是最新版', async () => {
    const rel = 'doc1.md';
    await writeMd(PROJECT, rel, 'A');
    await writeMd(PROJECT, rel, 'B');
    await writeMd(PROJECT, rel, 'C');

    expect(await readMd(PROJECT, rel)).toBe('C'); // 磁盘最新
    const snaps = await FH.list(abs(rel));
    const contents = await Promise.all(snaps.map((s) => FH.restore(abs(rel), s.id)));
    // A、B 被覆盖前都进了历史（overwrite-guard）；C 在磁盘上，尚未被覆盖
    expect(contents).toContain('A');
    expect(contents).toContain('B');
  });

  it('mark=manual 给当前内容留一条 manual 快照', async () => {
    const rel = 'doc2.md';
    await writeMd(PROJECT, rel, 'first');
    await writeMd(PROJECT, rel, 'pinned', { mark: 'manual' });
    const snaps = await FH.list(abs(rel));
    expect(snaps.some((s) => s.kind === 'manual')).toBe(true);
    // manual 快照内容 = 当前版
    const manual = snaps.find((s) => s.kind === 'manual')!;
    expect(await FH.restore(abs(rel), manual.id)).toBe('pinned');
  });

  it('restore 旧版：先留底当前版（pre-restore）再写回，磁盘变旧版', async () => {
    const rel = 'doc3.md';
    await writeMd(PROJECT, rel, 'old');
    await writeMd(PROJECT, rel, 'new'); // history: [old(overwrite-guard)]
    const snaps = await FH.list(abs(rel));
    const oldSnap = (await Promise.all(snaps.map(async (s) => ({ s, c: await FH.restore(abs(rel), s.id) })))).find(
      (x) => x.c === 'old',
    )!;

    const restored = await restoreWorkfileSnapshot(abs(rel), oldSnap.s.id);
    expect(restored).toBe('old');
    expect(await readMd(PROJECT, rel)).toBe('old'); // 磁盘恢复成旧版
    const after = await FH.list(abs(rel));
    expect(after.some((s) => s.kind === 'pre-restore')).toBe(true); // 恢复前把 'new' 留了底
  });

  it('原子写：不留 .tmp 残留', async () => {
    const rel = 'doc4.md';
    await writeMd(PROJECT, rel, 'x');
    const names = await fs.readdir(PROJECT);
    expect(names.some((n) => n.includes('.tmp.'))).toBe(false);
  });
});
