/**
 * deck .history → fileHistory 一次性迁移（项目B 第一期 Task6，最承重）。
 *
 * 钉死生死线-2「旧数据一条不丢」：
 * - 首次迁移：旧 vNNN.html 字节灌进中央仓、manifest 版本条目补 snapshotId、currentVersion 不变、
 *   旧 .history/versions 冻结只读、备份 .bak、落 sentinel。
 * - 幂等：sentinel 在不重迁；迁一半崩（无 sentinel）→ 重试清半套残留、不堆重复。
 * - 失败兜底：迁移抛 → 不写 sentinel、旧文件完好 → 读路径退回 legacy vNNN.html 仍能找回。
 * - 回滚：per-deck 恢复 .bak（丢 post-migration 版本）、删 sentinel、走 legacy。
 *
 * ORU_DIR 在业务 import 前重定向；业务模块动态 import。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-deck-migration-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const HTML_V1 = `<!doctype html><html><body><div class="slide"><h1>V1</h1></div></body></html>`;
const HTML_V2 = `<!doctype html><html><body><div class="slide"><h1>V2</h1></div></body></html>`;

let projectPath = '';

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  projectPath = join(ORU_DIR, 'prj');
  await fs.mkdir(projectPath, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

/** 造一个迁移前的旧 deck：.history/manifest.json（vNNN，无 snapshotId）+ versions/vNNN.html。 */
async function makeLegacyDeck(name: string): Promise<{ id: string; deckPath: string }> {
  const deckPath = join(projectPath, name);
  await fs.mkdir(join(deckPath, '.history', 'versions'), { recursive: true });
  await fs.writeFile(join(deckPath, 'index.html'), HTML_V2, 'utf-8'); // 当前 = v002
  await fs.writeFile(join(deckPath, '.history', 'versions', 'v001.html'), HTML_V1, 'utf-8');
  await fs.writeFile(join(deckPath, '.history', 'versions', 'v002.html'), HTML_V2, 'utf-8');
  const manifest = {
    version: 1,
    artifactId: 'will-be-replaced',
    currentVersion: 'v002',
    versions: [
      { id: 'v001', createdAt: 1000, kind: 'initial', summary: '首版', changedPages: [] },
      { id: 'v002', createdAt: 2000, kind: 'manual', summary: '改 V2', changedPages: [0] },
    ],
  };
  await fs.writeFile(join(deckPath, '.history', 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  const { registerExistingDeck } = await import('../../electron/main/deck/store');
  const rec = await registerExistingDeck({ projectId: 'prj_mig', name, path: deckPath });
  // manifest.artifactId 与注册 id 对齐（旧盘上写死的占位无所谓，迁移按 currentVersion/versions 走）
  return { id: rec.id, deckPath };
}

describe('deck 历史迁移', () => {
  it('新代码 deck（initManifest 建、无 sentinel）：落 sentinel 即返回，v001 中央仓字节不动，二次 no-op', async () => {
    // 走查二批该修 14 回归：新 deck 全版本带 snapshotId 却从不落 sentinel，旧判别每次激活都
    // 走「幂等清残」误删 v001 中央仓字节 → 此后 commit 静默抛错、版本历史停摆。
    const { migrateDeckIfNeeded } = await import('../../electron/main/deck/historyMigration');
    const { initManifest, readManifest, restoreVersionContent } = await import(
      '../../electron/main/deck/history'
    );
    const { deckLockKey, deckMigratedSentinelPath } = await import(
      '../../electron/main/deck/pathResolver'
    );
    const FH = await import('../../electron/main/fs/fileHistory');
    const { registerExistingDeck } = await import('../../electron/main/deck/store');

    const deckPath = join(projectPath, 'new-deck');
    await fs.mkdir(deckPath, { recursive: true });
    const rec = await registerExistingDeck({ projectId: 'prj_mig', name: 'new-deck', path: deckPath });
    await initManifest(rec.id, HTML_V1); // 新代码路径：字节进中央仓、不落 sentinel
    const n1 = (await FH.list(deckLockKey(deckPath))).length;
    expect(n1).toBeGreaterThan(0);

    await migrateDeckIfNeeded(rec.id); // 必须 resolves 而不是 ENOENT 抛出

    await fs.access(deckMigratedSentinelPath(deckPath)); // sentinel 落盘
    expect(await restoreVersionContent(rec.id, 'v001')).toBe(HTML_V1); // v001 字节未被清残误删
    const n2 = (await FH.list(deckLockKey(deckPath))).length;
    expect(n2).toBe(n1); // 中央仓未被 clear / 未堆重复
    expect((await readManifest(rec.id))!.versions[0].snapshotId).toBeDefined(); // manifest 未被改写

    await migrateDeckIfNeeded(rec.id); // 二次调用 no-op
    expect((await FH.list(deckLockKey(deckPath))).length).toBe(n1);
  });

  it('新 deck 迁移后 commitVersion 成功（挡 snapshotId 悬空→版本历史停摆回归）', async () => {
    const { migrateDeckIfNeeded } = await import('../../electron/main/deck/historyMigration');
    const { initManifest, commitVersion, restoreVersionContent } = await import(
      '../../electron/main/deck/history'
    );
    const { registerExistingDeck } = await import('../../electron/main/deck/store');

    const deckPath = join(projectPath, 'new-deck-commit');
    await fs.mkdir(deckPath, { recursive: true });
    const rec = await registerExistingDeck({
      projectId: 'prj_mig',
      name: 'new-deck-commit',
      path: deckPath,
    });
    await initManifest(rec.id, HTML_V1);
    await migrateDeckIfNeeded(rec.id);

    // 改动 index.html 后提交 v002——修复前此处因 v001 snapshotId 悬空抛 FILE_HISTORY_SNAPSHOT_NOT_FOUND
    await fs.writeFile(join(deckPath, 'index.html'), HTML_V2, 'utf-8');
    const v2 = await commitVersion(rec.id, 'manual', '改 V2');
    expect(v2.id).toBe('v002');
    expect(v2.snapshotId).toBeDefined();
    expect(await restoreVersionContent(rec.id, 'v001')).toBe(HTML_V1);
    expect(await restoreVersionContent(rec.id, 'v002')).toBe(HTML_V2);
  });

  it('真 legacy deck 缺版本文件：抛错带 versionId，中央仓残留不被 clear', async () => {
    const { migrateDeckIfNeeded } = await import('../../electron/main/deck/historyMigration');
    const { deckLockKey, deckMigratedSentinelPath } = await import(
      '../../electron/main/deck/pathResolver'
    );
    const FH = await import('../../electron/main/fs/fileHistory');
    const { id, deckPath } = await makeLegacyDeck('legacy-broken');
    await fs.rm(join(deckPath, '.history', 'versions', 'v002.html')); // 真损坏：缺 v002 文件
    // 中央仓放一份残留，模拟「上次迁一半崩」——读失败时绝不该被 clear（先删数据再发现读不出=真丢）
    const deckKey = deckLockKey(deckPath);
    const residue = await FH.commitSnapshot(deckKey, 'initial', 'residue');

    await expect(migrateDeckIfNeeded(id)).rejects.toThrow(/v002/);
    // 钉住「先校验读入、再 clear」：修复前残留已被删（此处 restore 抛）；循环已灌的 v001 不算数
    expect(await FH.restore(deckKey, residue.id)).toBe('residue');
    await expect(fs.access(deckMigratedSentinelPath(deckPath))).rejects.toThrow(); // sentinel 未落
  });

  it('首次迁移：字节进中央仓、版本补 snapshotId、currentVersion 不变、旧文件冻结、落 sentinel + .bak', async () => {
    const { migrateDeckIfNeeded } = await import('../../electron/main/deck/historyMigration');
    const { readManifest } = await import('../../electron/main/deck/history');
    const { deckLockKey, deckMigratedSentinelPath, deckManifestBakPath } = await import(
      '../../electron/main/deck/pathResolver'
    );
    const FH = await import('../../electron/main/fs/fileHistory');
    const { id, deckPath } = await makeLegacyDeck('legacy-a');

    await migrateDeckIfNeeded(id);

    const m = await readManifest(id);
    expect(m!.currentVersion).toBe('v002'); // 语义层 id 不变
    expect(m!.versions.map((v) => v.id)).toEqual(['v001', 'v002']);
    // 每条版本补了 snapshotId，字节在中央仓可 restore 回原内容
    const deckKey = deckLockKey(deckPath);
    expect(await FH.restore(deckKey, m!.versions[0].snapshotId!)).toBe(HTML_V1);
    expect(await FH.restore(deckKey, m!.versions[1].snapshotId!)).toBe(HTML_V2);
    // changedPages 等元数据原样搬
    expect(m!.versions[1].changedPages).toEqual([0]);
    // 旧 .history/versions 冻结只读（仍在）
    expect(await fs.readFile(join(deckPath, '.history', 'versions', 'v001.html'), 'utf-8')).toBe(HTML_V1);
    // sentinel + .bak 落地
    await fs.access(deckMigratedSentinelPath(deckPath));
    const bak = JSON.parse(await fs.readFile(deckManifestBakPath(deckPath), 'utf-8'));
    expect(bak.versions[0].snapshotId).toBeUndefined(); // .bak 是迁移前原样（无 snapshotId）
  });

  it('幂等：sentinel 在则不重迁（中央仓不堆重复快照）', async () => {
    const { migrateDeckIfNeeded } = await import('../../electron/main/deck/historyMigration');
    const { deckLockKey } = await import('../../electron/main/deck/pathResolver');
    const FH = await import('../../electron/main/fs/fileHistory');
    const { id, deckPath } = await makeLegacyDeck('legacy-idem');
    await migrateDeckIfNeeded(id);
    const n1 = (await FH.list(deckLockKey(deckPath))).length;
    await migrateDeckIfNeeded(id); // 再迁一次
    const n2 = (await FH.list(deckLockKey(deckPath))).length;
    expect(n2).toBe(n1); // 不重复
  });

  it('迁移后能 checkout 旧版找回（含找回内容写回 index.html）', async () => {
    const { migrateDeckIfNeeded } = await import('../../electron/main/deck/historyMigration');
    const { checkoutVersion } = await import('../../electron/main/deck/history');
    const { deckIndexPath } = await import('../../electron/main/deck/pathResolver');
    const { id, deckPath } = await makeLegacyDeck('legacy-checkout');
    await migrateDeckIfNeeded(id);
    const r = await checkoutVersion(id, 'v001', { force: true });
    expect(r.ok).toBe(true);
    expect(await fs.readFile(deckIndexPath(deckPath), 'utf-8')).toBe(HTML_V1);
  });

  it('失败兜底：未迁移时 restoreVersionContent 退回 legacy vNNN.html（不丢）', async () => {
    const { restoreVersionContent } = await import('../../electron/main/deck/history');
    const { id } = await makeLegacyDeck('legacy-nofallback');
    // 不调 migrate —— 老 deck 版本无 snapshotId，读路径必须退回 legacy 文件
    expect(await restoreVersionContent(id, 'v001')).toBe(HTML_V1);
    expect(await restoreVersionContent(id, 'v002')).toBe(HTML_V2);
  });

  it('回滚：恢复 .bak（无 snapshotId）、删 sentinel、读退回 legacy', async () => {
    const { migrateDeckIfNeeded, rollbackDeck } = await import('../../electron/main/deck/historyMigration');
    const { readManifest, restoreVersionContent } = await import('../../electron/main/deck/history');
    const { deckMigratedSentinelPath } = await import('../../electron/main/deck/pathResolver');
    const { id, deckPath } = await makeLegacyDeck('legacy-rollback');
    await migrateDeckIfNeeded(id);
    expect((await readManifest(id))!.versions[0].snapshotId).toBeDefined();

    await rollbackDeck(id);
    const m = await readManifest(id);
    expect(m!.versions[0].snapshotId).toBeUndefined(); // 回到迁移前
    await expect(fs.access(deckMigratedSentinelPath(deckPath))).rejects.toThrow(); // sentinel 删除
    // 读退回 legacy vNNN.html，旧版仍能找回
    expect(await restoreVersionContent(id, 'v001')).toBe(HTML_V1);
  });
});
