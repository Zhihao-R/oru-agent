/**
 * Artifact 对比/保存/取消 smoke —— prepareCompare / saveSubmission / cancelSubmission（6.1）
 *
 * 钉的真风险：
 * - prepareCompare：带 images/ 的 deck，两版快照 → 临时文件写在**根目录**（相对路径才解析对）、
 *   内容 == 对应快照；cleanupCompare 后两文件不存在（幂等）
 * - saveSubmission：完成组 + 一个 failed 标注 → save → 组没了、failed 标注 groupId 清空且
 *   status 仍 'failed'（不毁注释）、index.html 未变
 * - cancelSubmission：完成组 + 改 index.html → cancel → index.html 内容 == beforeVersion 快照、组没了
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDeck, resolveDeckPath } from '../../electron/main/deck/store';
import { initManifest, readManifest, restoreVersionContent } from '../../electron/main/deck/history';
import { addAnnotation, readAnnotations } from '../../electron/main/deck/annotations';
import { deckIndexPath } from '../../electron/main/deck/pathResolver';
import {
  submitAnnotations,
  finalizeSubmission,
  saveSubmission,
  cancelSubmission,
  getByGroup,
  getByArtifact,
  getSubmissionView,
  __resetForTest as resetSubmissions,
} from '../../electron/main/deck/submissions';
import { prepareCompare, cleanupCompare } from '../../electron/main/deck/compare';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

const HTML = `<!doctype html><html><body>
<section class="slide"><h1>A</h1><img src="images/x.png"></section>
</body></html>`;

const region = (comment: string) => ({
  comment,
  htmlSnippet: '',
  text: '',
  locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex: 0 },
});

const exists = (p: string) => fs.access(p).then(() => true).catch(() => false);

async function main() {
  resetSubmissions();
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'artifact-compare-'));
  const projectPath = join(tmpRoot, 'prj');
  await fs.mkdir(projectPath, { recursive: true });

  // ─── case 1: prepareCompare / cleanupCompare ───
  {
    const deck = await createDeck({ projectId: 'prj_c', projectPath, name: 'cmp1' });
    await initManifest(deck.id, HTML);
    const deckPath = await resolveDeckPath(deck.id);
    const beforeVersionId = (await readManifest(deck.id))!.currentVersion;
    // 第二版快照（内容不同）——直接 commit 一次模拟改后态
    const a1 = await addAnnotation(deck.id, region('改一下'));
    const r = await submitAnnotations({ artifactId: deck.id, annotationIds: [a1.id], conversationId: 'cnv_c1' });
    const fr = await finalizeSubmission(r.groupId, {});
    const afterVersionId = fr.afterVersionId!;

    const { beforeFile, afterFile } = await prepareCompare(deck.id, beforeVersionId, afterVersionId);
    assert(beforeFile === '.compare-before.html' && afterFile === '.compare-after.html', 'prepareCompare 回相对名');
    // 临时文件写在根目录（相对路径才解析对）
    const beforePath = join(deckPath, beforeFile);
    const afterPath = join(deckPath, afterFile);
    assert(await exists(beforePath) && await exists(afterPath), '临时文件写在制品根目录');
    // 内容 == 对应快照
    const [bTmp, aTmp, bSnap, aSnap] = await Promise.all([
      fs.readFile(beforePath, 'utf-8'),
      fs.readFile(afterPath, 'utf-8'),
      restoreVersionContent(deck.id, beforeVersionId), // 字节走中央仓（项目B）
      restoreVersionContent(deck.id, afterVersionId),
    ]);
    assert(bTmp === bSnap, 'before 临时文件内容 == beforeVersion 快照');
    assert(aTmp === aSnap, 'after 临时文件内容 == afterVersion 快照');

    await cleanupCompare(deck.id);
    assert(!(await exists(beforePath)) && !(await exists(afterPath)), 'cleanupCompare 后两文件不存在');
    // 幂等：再删一次不抛
    let threw = false;
    try { await cleanupCompare(deck.id); } catch { threw = true; }
    assert(!threw, 'cleanupCompare 幂等（再删不抛）');
  }

  // ─── case 2: saveSubmission（完成组 + 一个 failed 标注）───
  {
    const deck = await createDeck({ projectId: 'prj_c', projectPath, name: 'cmp2' });
    await initManifest(deck.id, HTML);
    const a1 = await addAnnotation(deck.id, region('做到'));
    const a2 = await addAnnotation(deck.id, region('做不到'));
    const r = await submitAnnotations({ artifactId: deck.id, annotationIds: [a1.id, a2.id], conversationId: 'cnv_c2' });
    await finalizeSubmission(r.groupId, { [a1.id]: { ok: true }, [a2.id]: { ok: false, reason: '页面没这个元素' } });
    const deckPath = await resolveDeckPath(deck.id);
    const indexBefore = await fs.readFile(deckIndexPath(deckPath), 'utf-8');

    const sr = await saveSubmission(r.groupId);
    assert(sr.ok && sr.key === deck.id, 'save 返回 ok + artifactId');
    assert(getByGroup(r.groupId) === undefined, 'save：组没了（getByGroup undefined）');
    assert(getByArtifact(deck.id) === undefined, 'save：getByArtifact undefined');
    assert(getSubmissionView(deck.id) === null, 'save：getSubmissionView null');

    const all = await readAnnotations(deck.id);
    assert(all.find((x) => x.id === a1.id) === undefined, 'save：成功标注已清除（finalize 时）');
    const fa2 = all.find((x) => x.id === a2.id);
    assert(
      fa2?.status === 'failed' && fa2.groupId === undefined && fa2.failureMessage === '页面没这个元素',
      'save：failed 标注 groupId 清空、status 仍 failed、注释保留',
    );
    const indexAfter = await fs.readFile(deckIndexPath(deckPath), 'utf-8');
    assert(indexBefore === indexAfter, 'save：index.html 未变');

    // 找不到 groupId → ok:false
    const sr2 = await saveSubmission('grp_nope');
    assert(sr2.ok === false, 'save 不存在 groupId → ok:false');
  }

  // ─── case 3: cancelSubmission（完成组 + 改 index.html → 回退到 beforeVersion）───
  {
    const deck = await createDeck({ projectId: 'prj_c', projectPath, name: 'cmp3' });
    await initManifest(deck.id, HTML);
    const a1 = await addAnnotation(deck.id, region('改它'));
    const r = await submitAnnotations({ artifactId: deck.id, annotationIds: [a1.id], conversationId: 'cnv_c3' });
    const beforeVersionId = r.beforeVersionId;
    await finalizeSubmission(r.groupId, {});
    const deckPath = await resolveDeckPath(deck.id);
    // 模拟改后态：手动改 index.html（让它跟 beforeVersion 不同）
    await fs.writeFile(deckIndexPath(deckPath), '<!doctype html><html><body>改后的脏内容</body></html>', 'utf-8');

    const cr = await cancelSubmission(r.groupId);
    assert(cr.ok && cr.key === deck.id, 'cancel 返回 ok + artifactId');
    assert(getByGroup(r.groupId) === undefined, 'cancel：组没了');

    const indexAfter = await fs.readFile(deckIndexPath(deckPath), 'utf-8');
    const beforeSnap = await restoreVersionContent(deck.id, beforeVersionId); // 字节走中央仓（项目B）
    assert(indexAfter === beforeSnap, 'cancel：index.html 内容 == beforeVersion 快照（回退）');

    const cr2 = await cancelSubmission('grp_nope');
    assert(cr2.ok === false, 'cancel 不存在 groupId → ok:false');
  }

  // ─── 汇总 ───
  const failed = RESULTS.filter((x) => !x.ok);
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
