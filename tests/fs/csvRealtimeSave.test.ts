/**
 * csv 实时落盘端到端（writeTextFile → 统一临界区 → FileHistory），技术设计 §3.1/§11.13（csv 一类）。
 *
 * 验证：①缺省 expectedDiskSha256 走 overwrite-guard 兜底不丢；②另存副本（expectedDiskSha256=null）
 * 是建新文件路径、撞名返回 conflict；③mark='manual' 留底；④restore 恢复。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-csvrealtime-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const PROJECT = join(ORU_DIR, 'project');

let writeTextFile!: typeof import('../../electron/main/fs/textFile').writeTextFile;
let FH!: typeof import('../../electron/main/fs/fileHistory');

beforeAll(async () => {
  await fs.mkdir(PROJECT, { recursive: true });
  ({ writeTextFile } = await import('../../electron/main/fs/textFile'));
  FH = await import('../../electron/main/fs/fileHistory');
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

const abs = (rel: string) => join(PROJECT, rel);

describe('csv 实时落盘', () => {
  it('连续写：覆盖前把上一版兜进历史（overwrite-guard）', async () => {
    const rel = 'a.csv';
    await writeTextFile(PROJECT, rel, 'h\nA\n');
    await writeTextFile(PROJECT, rel, 'h\nB\n');
    const snaps = await FH.list(abs(rel));
    const contents = await Promise.all(snaps.map((s) => FH.restore(abs(rel), s.id)));
    expect(contents).toContain('h\nA\n'); // A 被覆盖前进了历史
    expect(await fs.readFile(abs(rel), 'utf-8')).toBe('h\nB\n');
  });

  it('mark=manual 留底', async () => {
    const rel = 'b.csv';
    await writeTextFile(PROJECT, rel, 'h\n1\n');
    await writeTextFile(PROJECT, rel, 'h\n2\n', undefined, 'manual');
    const snaps = await FH.list(abs(rel));
    expect(snaps.some((s) => s.kind === 'manual')).toBe(true);
  });

  it('另存副本：expectedDiskSha256=null，撞名返回 conflict', async () => {
    const rel = 'c.csv';
    const first = await writeTextFile(PROJECT, rel, 'x\n', null); // 期望不存在 → saved
    expect(first.status).toBe('saved');
    const second = await writeTextFile(PROJECT, rel, 'y\n', null); // 已存在 → conflict，不覆盖
    expect(second.status).toBe('conflict');
    expect(await fs.readFile(abs(rel), 'utf-8')).toBe('x\n'); // 原件不动
  });
});
