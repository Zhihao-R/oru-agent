/**
 * Deck 模块核心 smoke —— 覆盖 electron/main/deck/ 关键路径。
 *
 * 1. pathResolver: sanitize / pickUniqueName 重名后缀
 * 2. store: createDeck / getDeck / active 切换 / resolveDeckPath
 * 3. annotations: add / update / remove / clearPending（页级注释）
 * 4. history: initManifest / commitVersion / listVersions / isDirty / checkoutVersion / missingImages
 * 5. undoStack: push / undo / redo / barrier / clearAll
 *
 * commitScheduler 的防抖在 __smoke_deck_scheduler__.ts 单跑（涉及定时器）。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizeDeckName, pickUniqueName } from '../../electron/main/deck/pathResolver';
import {
  createDeck,
  getDeck,
  listDecks,
  resolveDeckPath,
  getActiveDeckId,
  setActiveDeckId,
} from '../../electron/main/deck/store';
import { getCurrentOwnerId } from '../../electron/main/identity/getCurrentOwnerId';
import { userDir } from '../../electron/main/runtime/paths';
import {
  addAnnotation,
  readAnnotations,
  updateAnnotation,
  removeAnnotation,
  clearPendingAnnotations,
} from '../../electron/main/deck/annotations';
import {
  initManifest,
  commitVersion,
  listVersions,
  isDirty,
  checkoutVersion,
  readManifest,
  restoreVersionContent,
} from '../../electron/main/deck/history';
import {
  push as undoPush,
  undo as undoOne,
  redo as redoOne,
  pushBarrier,
  clearAll as clearUndoAll,
  __snapshot as undoSnapshot,
  __resetAllForTest as resetUndo,
} from '../../electron/main/deck/undoStack';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function expectThrowCode<T>(f: () => Promise<T>, expectedCode: string, name: string): Promise<void> {
  try {
    await f();
    assert(false, name, `expected throw ${expectedCode} but resolved`);
  } catch (e: unknown) {
    const err = e as { code?: string; message?: string };
    assert(err?.code === expectedCode, name, `actual code: ${err?.code}, message: ${err?.message}`);
  }
}

async function main() {
  // ─── 1. pathResolver ───
  assert(sanitizeDeckName('AI 私享会') === 'AI 私享会', '中文 + 空格保留');
  assert(sanitizeDeckName('a/b\\c:d*e?f"g<h>i|j') === 'a-b-c-d-e-f-g-h-i-j', '非法字符替换为 -');
  assert(sanitizeDeckName('---abc---') === 'abc', '首尾 - 去掉');
  assert(sanitizeDeckName('a---b---c') === 'a-b-c', '多个连续 - 合并');
  assert(sanitizeDeckName('').length === 0, '空串返回空');

  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'deck-smoke-'));
  // 模拟一个 project 目录
  const projectPath = join(tmpRoot, 'my-project');
  await fs.mkdir(projectPath, { recursive: true });

  assert((await pickUniqueName(projectPath, 'AI 私享会')) === 'AI 私享会', '不重名时直接返回 sanitize 后的');
  await fs.mkdir(join(projectPath, 'AI 私享会'));
  assert((await pickUniqueName(projectPath, 'AI 私享会')) === 'AI 私享会-2', '重名加 -2 后缀');
  await fs.mkdir(join(projectPath, 'AI 私享会-2'));
  assert((await pickUniqueName(projectPath, 'AI 私享会')) === 'AI 私享会-3', '继续重名加 -3');

  // ─── 2. store ───
  const deck1 = await createDeck({ projectId: 'prj_test', projectPath, name: '冲突测试 deck' });
  assert(deck1.id.startsWith('dck_'), 'createDeck 返回 id 是 dck_ 前缀');
  assert(deck1.name === '冲突测试 deck', 'name 保留原始用户输入');
  assert(deck1.path.endsWith('冲突测试 deck'), 'path 末段是 sanitize 后名');
  assert((await fs.stat(deck1.path)).isDirectory(), 'deck 目录已创建');
  assert((await fs.stat(join(deck1.path, 'images'))).isDirectory(), 'images/ 已创建');

  const deck2 = await createDeck({ projectId: 'prj_test', projectPath, name: '冲突测试 deck' });
  assert(deck2.path.endsWith('冲突测试 deck-2'), '同 project 重名 deck 加 -2');
  assert(deck2.id !== deck1.id, '重名也是独立 deck（不同 id）');

  const decks = await listDecks('prj_test');
  assert(decks.length === 2, 'listDecks 返回 2 条');
  assert(decks[0].updatedAt >= decks[1].updatedAt, 'listDecks 按 updatedAt 倒序');

  assert((await resolveDeckPath(deck1.id)) === deck1.path, 'resolveDeckPath 命中');
  await expectThrowCode(
    () => resolveDeckPath('dck_nonexistent'),
    'DECK_NOT_FOUND',
    'resolveDeckPath 不存在抛 DECK_NOT_FOUND',
  );

  assert(getActiveDeckId() === null, 'active deck 初始为 null');
  setActiveDeckId(deck1.id);
  assert(getActiveDeckId() === deck1.id, 'setActiveDeckId 生效');
  setActiveDeckId(null);
  assert(getActiveDeckId() === null, 'setActiveDeckId(null) 关闭');

  await expectThrowCode(
    () => createDeck({ projectId: 'prj_test', projectPath, name: '///\\\\' }),
    'DECK_NAME_INVALID',
    'createDeck 全非法字符名（sanitize 后空）抛 DECK_NAME_INVALID',
  );

  // ─── 3. history（initManifest / commitVersion / listVersions / isDirty / checkout / missingImages）───
  const initialHtml = `<!doctype html>
<html><body>
<section class="slide"><h1>第 1 页</h1></section>
<section class="slide"><p>第 2 页</p></section>
</body></html>`;
  const manifest = await initManifest(deck1.id, initialHtml);
  assert(manifest.currentVersion === 'v001', 'initManifest 起始版本 v001');
  assert(manifest.versions.length === 1 && manifest.versions[0].kind === 'initial', '首版 kind=initial');
  assert(
    (await fs.readFile(join(deck1.path, 'index.html'), 'utf-8')) === initialHtml,
    'index.html 已写',
  );
  // 项目B：v001 字节进 fileHistory 中央仓（退 .history/versions），按 snapshotId 取回 == initialHtml
  assert(
    (await restoreVersionContent(deck1.id, 'v001')) === initialHtml,
    'v001 字节进中央仓、可取回',
  );

  assert(!(await isDirty(deck1.id)), 'isDirty=false 当 index.html 跟 v001 一致');

  // 模拟用户改了 index.html
  const html2 = initialHtml.replace('第 1 页', '第 1 页 (updated)');
  await fs.writeFile(join(deck1.path, 'index.html'), html2, 'utf-8');
  assert(await isDirty(deck1.id), 'isDirty=true 当 index.html 跟 v001 不一致');

  const v002 = await commitVersion(deck1.id, 'batch', '改了第 1 页标题');
  assert(v002.id === 'v002', '第二版 id=v002');
  assert(v002.kind === 'batch', '记录 kind');
  assert(v002.changedPages.length === 1 && v002.changedPages[0] === 0, 'changedPages = [0]');
  assert(!(await isDirty(deck1.id)), 'commit 后 isDirty=false');

  const allVersions = await listVersions(deck1.id);
  assert(allVersions.length === 2, 'listVersions 返回 2 条');

  // checkout 回 v001
  const ck = await checkoutVersion(deck1.id, 'v001');
  assert(ck.ok, 'checkout v001 ok');
  assert(
    (await fs.readFile(join(deck1.path, 'index.html'), 'utf-8')) === initialHtml,
    'checkout 后 index.html = v001',
  );
  const manifestAfterCk = await readManifest(deck1.id);
  assert(manifestAfterCk?.currentVersion === 'v001', 'currentVersion 切回 v001');
  assert(manifestAfterCk?.versions.length === 2, 'checkout 不新增版本（manifest.versions 仍 2 条）');

  // missingImages 检查：写一个引用不存在 image 的版本
  const htmlWithImg = `<!doctype html><html><body>
<section class="slide"><img src="images/missing.png"></section>
</body></html>`;
  await fs.writeFile(join(deck1.path, 'index.html'), htmlWithImg, 'utf-8');
  await commitVersion(deck1.id, 'ai', 'AI 加了张图');
  const ckMissing = await checkoutVersion(deck1.id, 'v003');
  // current 已经是 v003 了，再 checkout v003 应该 ok（current 就在 v003 不存在图）——换个角度：从 v001 checkout 到 v003
  await checkoutVersion(deck1.id, 'v001');
  const ckMissingFromV1 = await checkoutVersion(deck1.id, 'v003');
  assert(!ckMissingFromV1.ok, 'checkout v003（引用 missing.png）返回 ok=false');
  if (!ckMissingFromV1.ok) {
    assert(
      ckMissingFromV1.missingImages.includes('images/missing.png'),
      'missingImages 含 missing.png',
    );
  }
  // force=true 强制 checkout
  const ckForced = await checkoutVersion(deck1.id, 'v003', { force: true });
  assert(ckForced.ok, 'force=true 时即使有 missingImages 也 ok');

  // version not found
  await expectThrowCode(
    () => checkoutVersion(deck1.id, 'v999'),
    'DECK_HISTORY_VERSION_NOT_FOUND',
    'checkout 不存在版本抛 DECK_HISTORY_VERSION_NOT_FOUND',
  );

  // ─── 4. annotations（v2 框选 region）───
  // 先 checkout 回 v001 让 deck 状态干净
  await checkoutVersion(deck1.id, 'v001', { force: true });

  // 构造 v2 region 注释的 helper（locator + 空捕获快照）
  const region = (comment: string, pageIndex: number) => ({
    comment,
    htmlSnippet: '',
    text: '',
    locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex },
  });

  const a1 = await addAnnotation(deck1.id, region('改简练', 0));
  assert(a1.id.startsWith('ann_'), 'addAnnotation 返回 ann_ 前缀 id');
  assert(a1.status === 'pending', '新建 status=pending');
  assert(a1.locator.pageIndex === 0, 'pageIndex 落进 locator');
  assert(a1.cropPath === '', '无 crop 时 cropPath 为空串');

  const a2 = await addAnnotation(deck1.id, region('统一灰度', 1));

  // 同一处 region 再 add 是**新增独立一条**（v2 不再按 pageIndex 唯一覆盖）
  const a3 = await addAnnotation(deck1.id, region('再加一条', 0));
  assert(a3.id !== a1.id, '同 pageIndex 再 add 是独立新条（不覆盖）');

  let all = await readAnnotations(deck1.id);
  assert(all.length === 3, 'readAnnotations 返回 3 条（多条独立不覆盖）');

  const updated = await updateAnnotation(deck1.id, a1.id, { comment: '改更简练' });
  assert(updated.comment === '改更简练', 'updateAnnotation 改 comment');
  assert(updated.updatedAt >= a1.updatedAt, 'updatedAt 增加');

  await expectThrowCode(
    () => updateAnnotation(deck1.id, 'ann_nonexistent', { comment: 'x' }),
    'DECK_ANNOTATION_NOT_FOUND',
    'update 不存在 annotation 抛 DECK_ANNOTATION_NOT_FOUND',
  );

  // 改 failed 注释的 comment 自动重置回 pending（保留 v1 逻辑）
  await updateAnnotation(deck1.id, a3.id, { status: 'failed', failureMessage: 'x' });
  const reReset = await updateAnnotation(deck1.id, a3.id, { comment: '改了内容' });
  assert(reReset.status === 'pending' && reReset.failureMessage === undefined, '改 failed 注释 comment 自动重置 pending');

  // 模拟提交失败 → 标 a2 failed，其余清 pending
  await updateAnnotation(deck1.id, a2.id, { status: 'failed', failureMessage: 'AI 改失败' });
  await clearPendingAnnotations(deck1.id);
  all = await readAnnotations(deck1.id);
  assert(all.length === 1 && all[0].id === a2.id, 'clearPending 后只剩 failed 那条');

  await removeAnnotation(deck1.id, a2.id);
  all = await readAnnotations(deck1.id);
  assert(all.length === 0, 'removeAnnotation 删后空');
  await removeAnnotation(deck1.id, 'ann_nonexistent');
  assert(true, 'removeAnnotation 不存在静默成功（幂等）');

  // ─── 4a. 并发 addAnnotation（RMW 写锁不丢更新）───
  const [c1, c2, c3] = await Promise.all([
    addAnnotation(deck1.id, region('并发 x', 0)),
    addAnnotation(deck1.id, region('并发 y', 1)),
    addAnnotation(deck1.id, region('并发 z', 2)),
  ]);
  const concurrentIds = new Set([c1.id, c2.id, c3.id]);
  assert(concurrentIds.size === 3, '并发 add 三条 id 各不相同');
  const afterConcurrent = await readAnnotations(deck1.id);
  assert(afterConcurrent.length === 3, '并发 add 三条全部落盘（无丢更新）');
  assert(
    [c1.id, c2.id, c3.id].every((id) => afterConcurrent.some((a) => a.id === id)),
    '并发 add 三条都能读回',
  );
  // 清场，不影响后续断言
  for (const a of afterConcurrent) await removeAnnotation(deck1.id, a.id);

  // ─── 4b. v1 旧注释读成 [] （丢弃，不迁移）───
  {
    const annPath = join(deck1.path, '.annotations.json');
    await fs.writeFile(
      annPath,
      JSON.stringify({ version: 1, artifactId: deck1.id, annotations: [{ id: 'ann_old', pageIndex: 0, comment: '旧页级', status: 'pending', createdAt: 1, updatedAt: 1 }] }),
      'utf-8',
    );
    const afterV1 = await readAnnotations(deck1.id);
    assert(afterV1.length === 0, 'v1 旧注释读成 []（丢弃）');
  }

  // ─── 4c. v2 字段往返完整 ───
  {
    const rich = await addAnnotation(deck1.id, {
      comment: '完整字段',
      htmlSnippet: '<p>hi</p>',
      text: 'hi',
      locator: { scrollY: 120, rect: { x: 5, y: 6, w: 7, h: 8 }, pageIndex: 2, selector: 'body > p:nth-of-type(1)' },
    });
    const back = (await readAnnotations(deck1.id)).find((a) => a.id === rich.id)!;
    assert(back.htmlSnippet === '<p>hi</p>' && back.text === 'hi', 'v2 往返 htmlSnippet/text');
    assert(back.locator.scrollY === 120 && back.locator.selector === 'body > p:nth-of-type(1)', 'v2 往返 locator');
    assert(back.locator.rect.w === 7 && back.locator.pageIndex === 2, 'v2 往返 rect/pageIndex');
    // 确认落盘 version=2
    const fileRaw = JSON.parse(await fs.readFile(join(deck1.path, '.annotations.json'), 'utf-8'));
    assert(fileRaw.version === 2, '.annotations.json 落盘 version=2');
    await removeAnnotation(deck1.id, rich.id);
  }

  // ─── 4d. crop 截图落盘 + 生命周期 ───
  {
    // 最小合法 PNG（1×1 透明）——只验落盘 / 删除，不验像素
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const withCrop = await addAnnotation(deck1.id, {
      comment: '带截图的框选',
      htmlSnippet: '',
      text: '',
      locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 } },
      cropPng: pngBytes,
    });
    assert(withCrop.cropPath === `.annotations/crops/${withCrop.id}.png`, 'addAnnotation 带 crop 时 cropPath 指向 crops/<id>.png');
    const cropAbs = join(deck1.path, '.annotations', 'crops', `${withCrop.id}.png`);
    const cropLanded = await fs.readFile(cropAbs).then((b) => b.equals(pngBytes)).catch(() => false);
    assert(cropLanded, 'crop bytes 落地到 .annotations/crops/<id>.png 且内容一致');

    // 接受 base64 字符串入参（协议层传的是 base64）
    const withCropB64 = await addAnnotation(deck1.id, {
      comment: 'base64 入参',
      htmlSnippet: '',
      text: '',
      locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 } },
      cropPng: pngBytes.toString('base64'),
    });
    const cropB64Abs = join(deck1.path, '.annotations', 'crops', `${withCropB64.id}.png`);
    assert(await fs.access(cropB64Abs).then(() => true).catch(() => false), 'base64 字符串 cropPng 也能落盘');

    // remove → 连带删 crop 文件
    await removeAnnotation(deck1.id, withCrop.id);
    assert(!(await fs.access(cropAbs).then(() => true).catch(() => false)), 'removeAnnotation 连带删 crop 文件');

    // clearPendingAnnotations → 连带删 pending 项的 crop（withCropB64 是 pending）
    await clearPendingAnnotations(deck1.id);
    assert(!(await fs.access(cropB64Abs).then(() => true).catch(() => false)), 'clearPendingAnnotations 连带删 pending 项的 crop');
  }

  // ─── 5. undoStack ───
  resetUndo();
  const did = 'dck_test_undo';
  assert(undoOne(did) === null, '空栈 undo 返回 null');
  assert(redoOne(did) === null, '空栈 redo 返回 null');

  undoPush(did, { kind: 'inline-edit', markerId: 'm-x', pageIndex: 0, beforeHtml: '<a/>', afterHtml: '<b/>' });
  undoPush(did, { kind: 'annotation-change', before: [], after: [] });

  let snap = undoSnapshot(did);
  assert(snap.undo.length === 2, '两次 push 后 undo 栈 2 项');

  const u1 = undoOne(did);
  assert(u1?.kind === 'annotation-change', 'undo 弹出最近一条');
  snap = undoSnapshot(did);
  assert(snap.undo.length === 1 && snap.redo.length === 1, 'undo 1 后 redo 栈 1');

  const r1 = redoOne(did);
  assert(r1?.kind === 'annotation-change', 'redo 恢复刚才那条');

  // 新 push 应清空 redo
  undoOne(did);                         // 把 annotation-change 再弹出去
  undoPush(did, { kind: 'ai-direct', beforeHtml: '<c/>' });
  snap = undoSnapshot(did);
  assert(snap.redo.length === 0, '新 push 清空 redo');

  // barrier
  pushBarrier(did);
  undoPush(did, { kind: 'inline-edit', markerId: 'm-y', pageIndex: 1, beforeHtml: '', afterHtml: '' });
  // 先弹出 inline-edit
  const u2 = undoOne(did);
  assert(u2?.kind === 'inline-edit', 'undo 弹出 inline-edit');
  // 再遇到 barrier 应返回 null 不消费
  const u3 = undoOne(did);
  assert(u3 === null, '遇到 barrier 返回 null');
  const u4 = undoOne(did);
  assert(u4 === null, 'barrier 不消费 → 反复 undo 仍是 null');

  pushBarrier(did);
  pushBarrier(did);
  snap = undoSnapshot(did);
  assert(snap.undo.filter((e) => e.kind === 'barrier').length === 1, '连续 barrier 去重');

  // clearAll
  clearUndoAll(did);
  snap = undoSnapshot(did);
  assert(snap.undo.length === 0 && snap.redo.length === 0, 'clearAll 清空');

  // cap = 100：push 101 条 → 最早一条被 shift
  resetUndo();
  const capDid = 'dck_cap_test';
  for (let i = 0; i < 101; i += 1) {
    undoPush(capDid, { kind: 'ai-direct', beforeHtml: `h${i}` });
  }
  const capSnap = undoSnapshot(capDid);
  assert(capSnap.undo.length === 100, 'undo 栈超 cap 后维持 100');
  // 最早的（h0）被 shift；最新一条（h100）在栈顶
  const top = capSnap.undo[capSnap.undo.length - 1];
  assert(top.kind === 'ai-direct' && (top as { beforeHtml: string }).beforeHtml === 'h100', '栈顶是最新一条');
  const bottom = capSnap.undo[0];
  assert(bottom.kind === 'ai-direct' && (bottom as { beforeHtml: string }).beforeHtml === 'h1', '栈底是第 2 条（h0 被 shift）');

  // ─── 8. store 注册表迁移：decks.json → artifacts.json ───
  {
    // 使用与上面 store 测试相同的隔离 HOME（ORU_DIR 已被 __smoke_isolate__ 重定向）
    const ownerId = getCurrentOwnerId();
    const dir = userDir(ownerId);
    const oldPath = join(dir, 'decks.json');
    const newPath = join(dir, 'artifacts.json');

    // 清除已有 artifacts.json（前面 store 测试已写过）
    try { await fs.unlink(newPath); } catch { /* 忽略不存在 */ }

    // 写一份旧版 decks.json（模拟旧数据）
    const legacyContent = JSON.stringify({
      version: 1,
      decks: [
        { id: 'dck_legacy', projectId: 'prj_leg', name: '旧制品', path: '/tmp/leg', createdAt: 1000, updatedAt: 1001 },
      ],
    });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(oldPath, legacyContent, 'utf-8');

    // 首次读取注册表 → 应触发迁移
    const migratedDecks = await listDecks('prj_leg');
    assert(migratedDecks.length === 1, '迁移后 listDecks 能读到旧数据');
    assert(migratedDecks[0].id === 'dck_legacy', '迁移后 id 保持不变');

    // artifacts.json 应已创建
    const artifactsExists = await fs.access(newPath).then(() => true).catch(() => false);
    assert(artifactsExists, '迁移后 artifacts.json 已生成');

    // 内容等价
    const newContent = JSON.parse(await fs.readFile(newPath, 'utf-8'));
    assert(newContent.decks[0].id === 'dck_legacy', 'artifacts.json 内容与旧数据等价');

    // 后续写入写的是 artifacts.json（创建一个新 deck，再确认 artifacts.json 包含它）
    const legacyProjectPath = join(tmpRoot, 'leg-prj');
    await fs.mkdir(legacyProjectPath, { recursive: true });
    const newDeck = await createDeck({ projectId: 'prj_leg', projectPath: legacyProjectPath, name: '新制品' });
    const afterAdd = JSON.parse(await fs.readFile(newPath, 'utf-8'));
    assert(afterAdd.decks.some((d: { id: string }) => d.id === newDeck.id), '新建 deck 写入 artifacts.json');

    // 幂等性：再次调用 listDecks 不报错、不重复迁移
    const secondRead = await listDecks('prj_leg');
    const uniqueIds = new Set(secondRead.map((d) => d.id));
    assert(uniqueIds.size === secondRead.length, '二次读取无重复（迁移幂等）');
    assert(secondRead.some((d) => d.id === 'dck_legacy'), '二次读取仍含旧数据');
  }

  // ─── 汇总 ───
  const failed = RESULTS.filter((r) => !r.ok);
  console.log('');
  console.log(`Total: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.error('Failures:');
    for (const f of failed) console.error(` - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke fatal error:', e);
  process.exit(1);
});
