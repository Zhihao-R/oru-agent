/**
 * deck 版本字节切到 fileHistory（项目B 第一期 Task4）。
 *
 * deck manifest 指针/语义层保留，version id 复用 fileHistory snapshot id；字节读写经 fileHistory，
 * 不再写 .history/versions/vNNN.html。验：init/ensure/commit/checkout/isDirty + null 分支。
 *
 * ORU_DIR 在 import 前重定向；业务模块动态 import（同 commitLock.test.ts）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-deck-historybytes-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const HTML_A = `<!doctype html><html><body><div class="slide"><h1>A</h1></div></body></html>`;
const HTML_B = `<!doctype html><html><body><div class="slide"><h1>B</h1></div></body></html>`;

let projectPath = '';

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  projectPath = join(ORU_DIR, 'prj');
  await fs.mkdir(projectPath, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

async function makeDeck(name: string, html: string): Promise<string> {
  const deckDir = join(projectPath, name);
  await fs.mkdir(deckDir, { recursive: true });
  await fs.writeFile(join(deckDir, 'index.html'), html, 'utf-8');
  const { registerExistingDeck } = await import('../../electron/main/deck/store');
  const rec = await registerExistingDeck({ projectId: 'prj_b', name, path: deckDir });
  return rec.id;
}

describe('deck 版本字节走 fileHistory', () => {
  it('initManifest：version id 仍 vNNN、snapshotId 指向中央仓字节、不写 vNNN.html', async () => {
    const { initManifest } = await import('../../electron/main/deck/history');
    const { deckVersionFile, deckLockKey } = await import('../../electron/main/deck/pathResolver');
    const { resolveDeckPath } = await import('../../electron/main/deck/store');
    const FH = await import('../../electron/main/fs/fileHistory');
    const id = await makeDeck('init-deck', HTML_A);
    const m = await initManifest(id, HTML_A);
    expect(m.currentVersion).toBe('v001'); // deck 版本 id 保留 vNNN（语义层），不改 id 空间
    const snapshotId = m.versions[0].snapshotId!;
    expect(snapshotId).toMatch(/^s\d+$/); // snapshotId 指向 fileHistory 字节
    const deckPath = await resolveDeckPath(id);
    // 字节在中央仓可 restore，且 .history/versions/ 不再有该版本文件
    expect(await FH.restore(deckLockKey(deckPath), snapshotId)).toBe(HTML_A);
    await expect(fs.access(deckVersionFile(deckPath, 'v001'))).rejects.toThrow();
  });

  it('commitVersionLocked：落新版到中央仓、manifest 推进、changedPages 仍算对', async () => {
    const { commitVersion, listVersions, readManifest } = await import('../../electron/main/deck/history');
    const { deckIndexPath, deckLockKey } = await import('../../electron/main/deck/pathResolver');
    const { resolveDeckPath } = await import('../../electron/main/deck/store');
    const FH = await import('../../electron/main/fs/fileHistory');
    const id = await makeDeck('commit-deck', HTML_A);
    const { initManifest } = await import('../../electron/main/deck/history');
    await initManifest(id, HTML_A);
    const deckPath = await resolveDeckPath(id);
    // 改 index.html 再 commit
    await fs.writeFile(deckIndexPath(deckPath), HTML_B, 'utf-8');
    const v = await commitVersion(id, 'manual', '改成 B');
    expect(v.id).toBe('v002');
    const m = await readManifest(id);
    expect(m!.currentVersion).toBe('v002');
    expect((await listVersions(id)).length).toBe(2);
    // 新版字节在中央仓（按 snapshotId 取）
    expect(await FH.restore(deckLockKey(deckPath), v.snapshotId!)).toBe(HTML_B);
  });

  it('checkoutVersion：从中央仓取旧版写回 index.html、currentVersion 移', async () => {
    const { initManifest, commitVersion, checkoutVersion } = await import('../../electron/main/deck/history');
    const { deckIndexPath } = await import('../../electron/main/deck/pathResolver');
    const { resolveDeckPath } = await import('../../electron/main/deck/store');
    const id = await makeDeck('checkout-deck', HTML_A);
    const m0 = await initManifest(id, HTML_A);
    const deckPath = await resolveDeckPath(id);
    await fs.writeFile(deckIndexPath(deckPath), HTML_B, 'utf-8');
    await commitVersion(id, 'manual', 'B');
    // checkout 回 v0（HTML_A）
    const r = await checkoutVersion(id, m0.currentVersion, { force: true });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(deckIndexPath(deckPath), 'utf-8')).toBe(HTML_A);
  });

  it('isDirty：index.html 与 currentVersion 快照内容比对', async () => {
    const { initManifest, isDirty } = await import('../../electron/main/deck/history');
    const { deckIndexPath } = await import('../../electron/main/deck/pathResolver');
    const { resolveDeckPath } = await import('../../electron/main/deck/store');
    const id = await makeDeck('dirty-deck', HTML_A);
    await initManifest(id, HTML_A);
    expect(await isDirty(id)).toBe(false);
    await fs.writeFile(deckIndexPath(await resolveDeckPath(id)), HTML_B, 'utf-8');
    expect(await isDirty(id)).toBe(true);
  });

  it('内容未变 commit：deck 仍新建独立版本条目，snapshotId 复用去重（before 不落空）', async () => {
    const { initManifest, commitVersion, readManifest } = await import('../../electron/main/deck/history');
    const id = await makeDeck('noop-deck', HTML_A);
    const m = await initManifest(id, HTML_A);
    const baseSnapshot = m.versions[0].snapshotId!;
    // index 未改动，commit protective —— deck 仍落一条 v002 版本条目（保 summary/零回退），
    // 但字节逐字节相同 → snapshotId 复用 v001 的（中央仓去重），before 指针不落空
    const v = await commitVersion(id, 'protective', '提交前暂存');
    expect(v.id).toBe('v002'); // 独立版本条目
    expect(v.snapshotId).toBe(baseSnapshot); // 字节去重，共享同一 snapshot
    expect((await readManifest(id))!.currentVersion).toBe('v002');
  });
});
