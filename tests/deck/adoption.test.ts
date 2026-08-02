/**
 * deck 找回（收编现有文件夹 + 懒初始化 history）
 *
 * - registerExistingDeck：纯登记一个指针，目录内容零写入、幂等（deck 找回 §3.1 / §5）。
 * - ensureManifest：收编 deck 首次落版本那一刻从现有 index.html 快照 v001，不覆盖 index.html；
 *   已有 manifest 不重建（§4.1）。
 * - 三处 hard-fail 入口（commitVersion / checkoutVersion / submitAnnotations）改成懒初始化（§4.2）。
 *
 * ORU_DIR 在任何业务 import 前重定向到 tmpdir；业务模块走动态 await import。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-adoption-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

// 一份合法的"翻得出页"deck（非 Oru 自产写法：裸 div.slide，无 oru 暗号）
const DECK_HTML = `<!doctype html><html><body>
<div class="slide"><h1>第一页</h1></div>
<div class="slide"><h1>第二页</h1></div>
</body></html>`;

let projectPath = '';

/** 在项目下造一个含 index.html 的现有文件夹（模拟 agent 手写的散落 deck），返回绝对路径 */
async function makeExistingDeck(folder: string, html = DECK_HTML): Promise<string> {
  const abs = join(projectPath, folder);
  await fs.mkdir(abs, { recursive: true });
  await fs.writeFile(join(abs, 'index.html'), html, 'utf-8');
  return abs;
}

describe('deck 找回', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
    projectPath = join(ORU_DIR, 'prj');
    await fs.mkdir(projectPath, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { __resetForTest } = await import('../../electron/main/deck/submissions');
    __resetForTest();
  });

  it('registerExistingDeck：登记后 listDecks 含之，目录内容零写入', async () => {
    const { registerExistingDeck, listDecks } = await import('../../electron/main/deck/store');
    const abs = await makeExistingDeck('冒险岛回忆杀');
    const before = await fs.readdir(abs);

    const rec = await registerExistingDeck({ projectId: 'prj_a', name: '冒险岛回忆杀', path: abs });
    expect(rec.path).toBe(abs);
    expect(rec.deckSkillId).toBeUndefined(); // 纯指针，无 skill

    const decks = await listDecks('prj_a');
    expect(decks.some((d) => d.id === rec.id)).toBe(true);

    // 断言目录内容零变化（不 mkdir images/、不写 stub、不建 .history）
    const after = await fs.readdir(abs);
    expect(after.sort()).toEqual(before.sort());
    expect(after).toEqual(['index.html']);
  });

  it('registerExistingDeck：同 path 幂等返回原记录，不重复加入', async () => {
    const { registerExistingDeck, listDecks } = await import('../../electron/main/deck/store');
    const abs = await makeExistingDeck('幂等稿');
    const first = await registerExistingDeck({ projectId: 'prj_idem', name: '幂等稿', path: abs });
    const second = await registerExistingDeck({ projectId: 'prj_idem', name: '改个名', path: abs });
    expect(second.id).toBe(first.id);
    const decks = await listDecks('prj_idem');
    expect(decks.filter((d) => d.path === abs).length).toBe(1);
  });

  it('ensureManifest：无 manifest → 从现有 index.html 快照 v001，且不覆盖 index.html', async () => {
    const { registerExistingDeck } = await import('../../electron/main/deck/store');
    const { ensureManifest } = await import('../../electron/main/deck/history');
    const abs = await makeExistingDeck('快照稿');
    const rec = await registerExistingDeck({ projectId: 'prj_snap', name: '快照稿', path: abs });

    const m = await ensureManifest(rec.id);
    expect(m.currentVersion).toBe('v001');
    expect(m.versions).toHaveLength(1);
    expect(m.versions[0].kind).toBe('initial');

    // index.html 原封不动
    const idx = await fs.readFile(join(abs, 'index.html'), 'utf-8');
    expect(idx).toBe(DECK_HTML);
    // v001 字节进中央仓（项目B：退 .history/versions），按 snapshotId restore 得现有 index.html 内容
    const FH = await import('../../electron/main/fs/fileHistory');
    const { deckLockKey } = await import('../../electron/main/deck/pathResolver');
    expect(await FH.restore(deckLockKey(abs), m.versions[0].snapshotId!)).toBe(DECK_HTML);
  });

  it('ensureManifest：已有 manifest 不重建（幂等）', async () => {
    const { registerExistingDeck } = await import('../../electron/main/deck/store');
    const { ensureManifest } = await import('../../electron/main/deck/history');
    const abs = await makeExistingDeck('已初始化稿');
    const rec = await registerExistingDeck({ projectId: 'prj_dup', name: '已初始化稿', path: abs });
    const m1 = await ensureManifest(rec.id);
    const m2 = await ensureManifest(rec.id);
    expect(m2.versions).toHaveLength(1);
    expect(m2.versions[0].createdAt).toBe(m1.versions[0].createdAt); // 没重建
  });

  it('懒初始化不被 UI 顺手破坏：adopt 后未编辑就打开历史面板（listVersions）→ 空、不建 manifest、目录零写入', async () => {
    const { registerExistingDeck } = await import('../../electron/main/deck/store');
    const { listVersions } = await import('../../electron/main/deck/history');
    const abs = await makeExistingDeck('只看不改稿');
    const rec = await registerExistingDeck({ projectId: 'prj_view', name: '只看不改稿', path: abs });

    const versions = await listVersions(rec.id);
    expect(versions).toEqual([]); // 无 manifest → 空，不抛
    // 没编辑就只看历史，不该建 .history（目录仍只有 index.html）
    const after = await fs.readdir(abs);
    expect(after).toEqual(['index.html']);
  });

  it('commitVersion 入口：收编 deck 首次 commit 自动建 v001 再继续（不撞 hard-fail）', async () => {
    const { registerExistingDeck } = await import('../../electron/main/deck/store');
    const { commitVersion, listVersions } = await import('../../electron/main/deck/history');
    const abs = await makeExistingDeck('首次commit稿');
    const rec = await registerExistingDeck({ projectId: 'prj_commit', name: '首次commit稿', path: abs });

    // 无 manifest 直接 commit——不抛"manifest 未初始化"，自动建 v001 后落 v002
    const v = await commitVersion(rec.id, 'inline', '改了一行');
    expect(v.id).toBe('v002');
    const versions = await listVersions(rec.id);
    expect(versions.map((x) => x.id)).toEqual(['v001', 'v002']);
  });

  it('submitAnnotations 入口：收编 deck 框选标注主路径不撞 hard-fail，beforeVersionId=v001', async () => {
    const { registerExistingDeck } = await import('../../electron/main/deck/store');
    const { submitAnnotations } = await import('../../electron/main/deck/submissions');
    const abs = await makeExistingDeck('标注稿');
    const rec = await registerExistingDeck({ projectId: 'prj_anno', name: '标注稿', path: abs });

    // 无 manifest（isDirty 恒 false 走 else 分支）→ 懒初始化建 v001 作 beforeVersionId
    const r = await submitAnnotations({ artifactId: rec.id, annotationIds: [], conversationId: 'cnv_anno' });
    expect(r.beforeVersionId).toBe('v001');
  });

  it('两侧口径预筛：非 Oru 写法的 dist（翻不出页）segmentSlides=0 → 不该被收编', async () => {
    const { segmentSlides } = await import('../../electron/main/deck/deckModel');
    // 普通网页 / dist 产物：单个根容器、无 class=slide 块
    expect(segmentSlides('<!doctype html><html><body><div id="app">hi</div></body></html>').length).toBe(0);
    // 真 deck（裸 div.slide）：预筛 >=1（真值源仍是渲染端，main 只预筛）
    expect(segmentSlides(DECK_HTML).length).toBe(2);
  });
});
