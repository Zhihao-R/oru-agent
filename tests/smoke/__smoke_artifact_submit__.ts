/**
 * Artifact 提交链路 smoke —— submitAnnotations（5.1）+ stopSubmission（5.3）
 *
 * 钉的真风险：
 * - submit → beforeVersionId 真实存在、标注转 submitted+groupId、Submission 建好
 * - 已有未完成 Submission 时再 submit → 拒绝（并发约束 §6.4）
 * - stopSubmission → 标注回 pending、清 groupId、Submission 删、释放并发约束可重提
 * - 崩溃兜底（§6.6）：标注 submitted+groupId 但内存无 Submission（=重启后内存 Map 空）
 *   → 加载时 reconcile 降回 pending、清 groupId、可重新 submit；failed 标注清 groupId
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDeck } from '../../electron/main/deck/store';
import { initManifest, readManifest } from '../../electron/main/deck/history';
import { addAnnotation, readAnnotations, updateAnnotation } from '../../electron/main/deck/annotations';
import {
  submitAnnotations,
  stopSubmission,
  reconcileOrphanedSubmissions,
  getByGroup,
  getByArtifact,
  __resetForTest as resetSubmissions,
} from '../../electron/main/deck/submissions';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

const HTML = `<!doctype html><html><body>
<section class="slide"><h1>A</h1></section>
<section class="slide"><p>B</p></section>
</body></html>`;

const region = (comment: string, pageIndex: number) => ({
  comment,
  htmlSnippet: '',
  text: '',
  locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex },
});

async function main() {
  resetSubmissions();
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'artifact-submit-'));
  const projectPath = join(tmpRoot, 'prj');
  await fs.mkdir(projectPath, { recursive: true });
  const deck = await createDeck({ projectId: 'prj_s', projectPath, name: 'submit-deck' });
  await initManifest(deck.id, HTML);

  const a1 = await addAnnotation(deck.id, region('改标题', 0));
  const a2 = await addAnnotation(deck.id, region('改正文', 1));
  const a3 = await addAnnotation(deck.id, region('不提交这条', 0));
  // a4 带 crop 截图：用最小合法 PNG 字节（1x1 透明），验 payload 带回 cropBase64
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const a4 = await addAnnotation(deck.id, { ...region('带截图的标注', 0), cropPng: PNG_1x1 });

  // ─── submit a1 + a2 + a4 ───
  const r = await submitAnnotations({
    artifactId: deck.id,
    annotationIds: [a1.id, a2.id, a4.id],
    conversationId: 'cnv_x',
  });
  assert(r.groupId.startsWith('grp_'), 'submit 返回 grp_ 前缀 groupId');

  // 不 dirty（initManifest 后 index===current）→ beforeVersionId 用 currentVersion
  const manifest = await readManifest(deck.id);
  assert(r.beforeVersionId === manifest?.currentVersion, 'beforeVersionId 真实存在=currentVersion');
  // 项目B：beforeVersion 字节进 fileHistory 中央仓（退 .history/versions），可按 snapshotId 取回
  const { restoreVersionContent } = await import('../../electron/main/deck/history');
  const beforeBytes = await restoreVersionContent(deck.id, r.beforeVersionId).catch(() => null);
  assert(beforeBytes !== null, 'beforeVersionId 字节可从中央仓取回');

  // payload 含每条 comment + cropPath
  assert(r.payload.length === 3, 'payload 含 3 条');
  assert(
    r.payload.find((p) => p.annotationId === a1.id)?.comment === '改标题',
    'payload 带 comment',
  );

  // crop 字节：a4 有截图 → 带非空 cropBase64；a1 无截图 → 省略该字段
  const p4 = r.payload.find((p) => p.annotationId === a4.id)!;
  const p1 = r.payload.find((p) => p.annotationId === a1.id)!;
  assert(
    typeof p4.cropBase64 === 'string' &&
      p4.cropBase64.length > 0 &&
      Buffer.from(p4.cropBase64, 'base64').equals(PNG_1x1),
    '有 crop 的标注 payload 带非空 cropBase64（字节往返一致）',
  );
  assert(p1.cropBase64 === undefined, '无 crop 的标注 payload 不带 cropBase64');

  // 标注 a1/a2 转 submitted + 打 groupId；a3 保持 pending
  let all = await readAnnotations(deck.id);
  const ga1 = all.find((x) => x.id === a1.id)!;
  const ga2 = all.find((x) => x.id === a2.id)!;
  const ga3 = all.find((x) => x.id === a3.id)!;
  assert(ga1.status === 'submitted' && ga1.groupId === r.groupId, 'a1 转 submitted+groupId');
  assert(ga2.status === 'submitted' && ga2.groupId === r.groupId, 'a2 转 submitted+groupId');
  assert(ga3.status === 'pending' && ga3.groupId === undefined, 'a3 保持 pending 无 groupId');

  // Submission 建好（修改中：无 afterVersionId）
  const sub = getByGroup(r.groupId)!;
  assert(!!sub && sub.afterVersionId === undefined, 'Submission 建好且为修改中（无 afterVersionId）');
  assert(getByArtifact(deck.id)?.groupId === r.groupId, 'getByArtifact 命中该组');

  // ─── 并发约束：已有未完成组时再 submit → 拒绝 ───
  let rejected = false;
  let rejectCode = '';
  try {
    await submitAnnotations({ artifactId: deck.id, annotationIds: [a3.id], conversationId: 'cnv_x' });
  } catch (e) {
    rejected = true;
    rejectCode = (e as { code?: string }).code ?? '';
  }
  assert(rejected && rejectCode === 'ARTIFACT_SUBMISSION_IN_PROGRESS', '已有未完成组时再 submit 被拒');
  // 拒绝后 a3 仍 pending（没被污染成 submitted）
  all = await readAnnotations(deck.id);
  assert(all.find((x) => x.id === a3.id)?.status === 'pending', '被拒后 a3 status 未被污染');

  // ─── stopSubmission：撤回 ───
  const stop = await stopSubmission(r.groupId);
  assert(stop.ok && stop.key === deck.id, 'stopSubmission 成功');
  all = await readAnnotations(deck.id);
  assert(
    all.find((x) => x.id === a1.id)?.status === 'pending' &&
      all.find((x) => x.id === a1.id)?.groupId === undefined,
    'stop 后 a1 回 pending 且清 groupId',
  );
  assert(
    all.find((x) => x.id === a2.id)?.status === 'pending' &&
      all.find((x) => x.id === a2.id)?.groupId === undefined,
    'stop 后 a2 回 pending 且清 groupId',
  );
  assert(getByGroup(r.groupId) === undefined, 'stop 后 Submission 删除');

  // ─── 释放并发约束 → 可再次 submit ───
  const r2 = await submitAnnotations({
    artifactId: deck.id,
    annotationIds: [a1.id, a2.id, a3.id],
    conversationId: 'cnv_y',
  });
  assert(r2.groupId !== r.groupId, 'stop 后可再次 submit（新 groupId）');
  assert(getByArtifact(deck.id)?.groupId === r2.groupId, '重提后并发槽位被新组占据');

  // ─── stop 对已不存在 / 已完成的 group → no-op false ───
  resetSubmissions();
  const noopStop = await stopSubmission('grp_nonexistent');
  assert(!noopStop.ok, 'stop 不存在 group → no-op false');

  // ─── 崩溃兜底（§6.6）：孤儿 submitted 降级 ───────────────────────
  // 模拟"进程重启"：标注落盘是 submitted+groupId，但内存 Map 为空（无对应 Submission）。
  // 直接写盘一个 submitted 标注 + 一个 failed 标注（带失效 groupId），不建任何 Submission。
  resetSubmissions();
  const orphanDeck = await createDeck({ projectId: 'prj_s', projectPath, name: 'orphan-deck' });
  await initManifest(orphanDeck.id, HTML);
  const o1 = await addAnnotation(orphanDeck.id, region('孤儿提交', 0));
  const o2 = await addAnnotation(orphanDeck.id, region('孤儿失败', 1));
  const deadGroup = 'grp_dead_from_prev_process';
  await updateAnnotation(orphanDeck.id, o1.id, { status: 'submitted', groupId: deadGroup });
  await updateAnnotation(orphanDeck.id, o2.id, { status: 'failed', groupId: deadGroup, failureMessage: '上次没改成' });

  // 前置确认：内存里确实没有这个组的 live Submission（重启场景）
  assert(getByGroup(deadGroup) === undefined, '前置：内存无对应 live Submission（重启态）');

  // 触发加载 reconcile
  const reconciled = await reconcileOrphanedSubmissions(orphanDeck.id);
  assert(reconciled, 'reconcile 报告有改动');

  let orphanAll = await readAnnotations(orphanDeck.id);
  const ro1 = orphanAll.find((x) => x.id === o1.id)!;
  const ro2 = orphanAll.find((x) => x.id === o2.id)!;
  assert(ro1.status === 'pending' && ro1.groupId === undefined, '孤儿 submitted 降回 pending + 清 groupId');
  assert(ro2.status === 'failed' && ro2.groupId === undefined, '孤儿 failed 保留 failed 但清失效 groupId');

  // 降级后可重新 submit（不依赖丢失的旧基准）
  const reSub = await submitAnnotations({
    artifactId: orphanDeck.id,
    annotationIds: [o1.id],
    conversationId: 'cnv_z',
  });
  assert(reSub.groupId.startsWith('grp_') && reSub.groupId !== deadGroup, '降级后可重新 submit（新 groupId）');
  orphanAll = await readAnnotations(orphanDeck.id);
  assert(
    orphanAll.find((x) => x.id === o1.id)?.status === 'submitted',
    '重提后孤儿标注重新转 submitted',
  );

  // reconcile 幂等：此刻 o1 有 live Submission（刚 reSub）→ 不该再被降级
  const reconciled2 = await reconcileOrphanedSubmissions(orphanDeck.id);
  assert(!reconciled2, 'reconcile 对有 live Submission 的 submitted 不动（幂等，无误降级）');
  orphanAll = await readAnnotations(orphanDeck.id);
  assert(
    orphanAll.find((x) => x.id === o1.id)?.status === 'submitted',
    '二次 reconcile 不误降级活跃 submitted',
  );

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
