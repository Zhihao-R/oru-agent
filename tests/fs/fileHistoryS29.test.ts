/**
 * S29（G90）冲突卡收口 · fileHistory 内核：冲突类快照种类、开卡双方版本入历史、落选补标。
 * 走真实 fs（ORU_DIR 重定向 + 动态 import）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-s29fh-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const PROJECT = join(ORU_DIR, 'project');

let FH!: typeof import('../../electron/main/fs/fileHistory');

let seq = 0;
function freshKey(): string {
  return resolve(join(PROJECT, `wf-${seq++}.md`));
}

beforeAll(async () => {
  await fs.mkdir(PROJECT, { recursive: true });
  FH = await import('../../electron/main/fs/fileHistory');
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('S29 · G90 开卡双方版本入历史', () => {
  it('snapshotConflictPair 把 mine 与 theirs 各存一版、都对用户可见、都可点回', async () => {
    const key = freshKey();
    const { mineId, theirsId } = await FH.snapshotConflictPair(key, '我的草稿', 'AI 的版本');
    expect(mineId).not.toBe(theirsId);

    const visible = await FH.listForUser(key);
    const conflictVers = visible.filter((s) => s.kind === 'conflict-version');
    expect(conflictVers).toHaveLength(2);

    // 两版内容都点得回（承重：mine 从未落盘，崩溃也不丢）
    expect(await FH.restore(key, mineId)).toBe('我的草稿');
    expect(await FH.restore(key, theirsId)).toBe('AI 的版本');
  });

  it('lastHash 末尾收在 theirs（磁盘现状）上，不致下次覆盖误兜 mine', async () => {
    const key = freshKey();
    await FH.snapshotConflictPair(key, 'MINE', 'THEIRS');
    // theirs 即磁盘现状：再以 theirs 为 cur 走 guardOverwrite 不应产生新兜底快照
    const before = (await FH.list(key)).length;
    await FH.guardOverwrite(key, 'THEIRS', 'ai');
    expect((await FH.list(key)).length).toBe(before);
  });
});

describe('S29 · G90 落选补标（方案 B）', () => {
  it('retagSnapshot 把落选那份从 conflict-version 改判 conflict-losing', async () => {
    const key = freshKey();
    const { mineId, theirsId } = await FH.snapshotConflictPair(key, 'mine', 'theirs');
    // 用户二选一保留 mine → theirs 落选
    await FH.retagSnapshot(key, theirsId, 'conflict-losing');

    const all = await FH.list(key);
    expect(all.find((s) => s.id === theirsId)!.kind).toBe('conflict-losing');
    expect(all.find((s) => s.id === mineId)!.kind).toBe('conflict-version');
    // 落选版仍对用户可见可点回
    expect(await FH.restore(key, theirsId)).toBe('theirs');
  });

  it('retagSnapshot 对不存在的 id 安全 no-op', async () => {
    const key = freshKey();
    await FH.snapshotConflictPair(key, 'a', 'b');
    await expect(FH.retagSnapshot(key, 's999', 'conflict-losing')).resolves.toBeUndefined();
  });

  it('冲突版本按里程碑保留、抗封顶稀释', async () => {
    const key = freshKey();
    const { mineId } = await FH.snapshotConflictPair(key, 'keepme', 'other');
    // 灌满周期取样把封顶（MAX_PER_FILE=200）顶爆，冲突版本（PROTECTED_KINDS）不应被稀释掉
    for (let i = 0; i < 210; i++) await FH.snapshot(key, 'periodic', `p${i}`);
    const list = await FH.list(key);
    expect(list.length).toBeLessThanOrEqual(200); // 确证封顶已触发稀释
    expect(list.find((s) => s.id === mineId)).toBeDefined(); // 冲突版本仍在
  }, 20_000);
});
