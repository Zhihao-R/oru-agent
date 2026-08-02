/**
 * HTML 标注提交端到端 smoke —— 走真实 WS router 的 html.* 路径（项目B 第三期 Task14）
 *
 * 钉的承重点（html 不伪装成 deck，旁路 deck 体检）：
 * - 全程**无 deck / 无 project**：松散 html 文件直接走 htmlTarget(htmlPath) → 共用提交内核。
 *   能跑通即证明：不套 artifactId、不调 resolveDeckPath/validateDeck（这些对松散 html 会抛）。
 * - 广播一律 html.*（C-2）：handler 不复用 deck onArtifactSubmissionChanged（其内 readAnnotations(artifactId)
 *   是 deck 适配器、html 会抛）；断言**没有任何 artifact.* 广播**漏出。
 * - 收尾走核心 finalizeSubmission(groupId)（C-1）：不经 deck agentTool（含 flushPending/isDirty/validateDeck）。
 * - before/after = fileHistory snapshot id（sNNN），非 deck 的 vNNN——证明走 html 薄指针。
 * - 同目录两个松散 html sidecar 互不覆盖（脱 artifact 的核心动机）。
 * - 对比临时文件落 html 同目录、带 .{base} 前缀防撞；exit 后清掉。cancel 回退 htmlPath 内容。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';

import { route } from '../../electron/main/ws/router';
import type { ClientRequest, ServerEventPayload } from '../../shared/protocol';
import type { Reply, Broadcast } from '../../electron/main/ws/server';
import { HTML_MSG } from '../../shared/htmlProtocol';
import { __resetForTest as resetSubmissions } from '../../electron/main/deck/submissions';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

/** 走真实 WS router 跑一条请求，捕获 reply / broadcast（不复刻 handler 逻辑，分流改了这里会红）。 */
async function routeOnce(
  req: ClientRequest,
): Promise<{ replies: ServerEventPayload[]; broadcasts: ServerEventPayload[] }> {
  const replies: ServerEventPayload[] = [];
  const broadcasts: ServerEventPayload[] = [];
  const reply = ((_reqId: string, event: ServerEventPayload) => {
    replies.push(event);
  }) satisfies Reply;
  const broadcast = ((event: ServerEventPayload) => {
    broadcasts.push(event);
  }) satisfies Broadcast;
  await route(req, reply, broadcast);
  return { replies, broadcasts };
}

/** 任一广播是 artifact.* → 漏用了 deck 广播路径（违 C-2）。 */
function hasArtifactBroadcast(events: ServerEventPayload[]): boolean {
  return events.some((e) => typeof e.type === 'string' && e.type.startsWith('artifact.'));
}

const HTML_A = '<!doctype html><html><body><h1>改前 A</h1></body></html>';
const HTML_B = '<!doctype html><html><body><h1>改后 B</h1></body></html>';
// 1x1 透明 PNG（验 crop 字节往返）
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const ev = (events: ServerEventPayload[], type: string) =>
  events.find((e) => e.type === type) as Record<string, unknown> | undefined;

let reqSeq = 0;
const reqId = () => `r${(reqSeq += 1)}`;

async function main() {
  resetSubmissions();
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'html-submit-'));
  const dir = join(tmpRoot, 'docs');
  await fs.mkdir(dir, { recursive: true });
  const htmlA = join(dir, 'a.html');
  const htmlB = join(dir, 'b.html');
  await fs.writeFile(htmlA, HTML_A);
  await fs.writeFile(htmlB, HTML_B);

  // ─── addAnnotation（带 crop）→ ack + html.annotationsChanged + sidecar 落盘 ───
  {
    const { replies, broadcasts } = await routeOnce({
      type: HTML_MSG.addAnnotation,
      reqId: reqId(),
      htmlPath: htmlA,
      annotation: { comment: '改标题', htmlSnippet: '<h1>改前 A</h1>', text: '改前 A', locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 } } },
      cropPngBase64: PNG_1x1.toString('base64'),
    });
    assert(replies.length === 1 && replies[0]?.type === 'ack', 'addAnnotation 回单条 ack');
    const ac = ev(broadcasts, HTML_MSG.annotationsChanged);
    assert(!!ac && ac.htmlPath === htmlA, 'addAnnotation 广播 html.annotationsChanged 带 htmlPath');
    assert(Array.isArray(ac?.annotations) && (ac!.annotations as unknown[]).length === 1, '广播带 1 条标注');
    assert(!hasArtifactBroadcast(broadcasts), 'addAnnotation 无 artifact.* 广播漏出（C-2）');
    // sidecar 落 html 旁、文件名带 .a.html 前缀（同目录不撞）
    const sidecar = join(dir, '.a.html.annotations.json');
    assert(await fs.readFile(sidecar, 'utf-8').then(() => true, () => false), 'sidecar 落 .a.html.annotations.json');
  }

  // 取标注 id（再加一条无 crop 的）
  let a1Id = '';
  {
    const { broadcasts } = await routeOnce({
      type: HTML_MSG.addAnnotation,
      reqId: reqId(),
      htmlPath: htmlA,
      annotation: { comment: '再改一处', htmlSnippet: '', text: '', locator: { scrollY: 0, rect: { x: 0, y: 0, w: 0, h: 0 } } },
    });
    const anns = (ev(broadcasts, HTML_MSG.annotationsChanged)!.annotations as Array<{ id: string; comment: string }>);
    a1Id = anns.find((a) => a.comment === '改标题')!.id;
    assert(anns.length === 2, '第二条 addAnnotation 后共 2 条标注');
  }

  // ─── updateAnnotation（改评论）→ status 回 pending（commentChanged）+ 广播 ───
  let a2Id = '';
  {
    // 先拿 a2 的 id
    const { broadcasts: b0 } = await routeOnce({ type: HTML_MSG.addAnnotation, reqId: reqId(), htmlPath: htmlA, annotation: { comment: '待删', htmlSnippet: '', text: '', locator: { scrollY: 0, rect: { x: 0, y: 0, w: 0, h: 0 } } } });
    const anns = ev(b0, HTML_MSG.annotationsChanged)!.annotations as Array<{ id: string; comment: string }>;
    a2Id = anns.find((a) => a.comment === '待删')!.id;
    // 删掉它
    const { replies, broadcasts } = await routeOnce({ type: HTML_MSG.removeAnnotation, reqId: reqId(), htmlPath: htmlA, annotationId: a2Id });
    assert(replies[0]?.type === 'ack', 'removeAnnotation 回 ack');
    const left = ev(broadcasts, HTML_MSG.annotationsChanged)!.annotations as unknown[];
    assert(left.length === 2, 'removeAnnotation 后回到 2 条');
  }

  // ─── html.activate：打开预览时从 sidecar 加载已存标注（验收闸"关掉再打开卡片还在"）───
  {
    const { replies } = await routeOnce({ type: HTML_MSG.activate, reqId: reqId(), htmlPath: htmlA });
    const res = replies[0] as Record<string, unknown>;
    assert(res?.type === HTML_MSG.activateResult && res.htmlPath === htmlA, 'activate 回 html.activate.result');
    assert((res.annotations as unknown[]).length === 2, 'activate 从 sidecar 加载 2 条已存标注');
    assert(res.submission === null, 'activate 无活跃组时 submission=null');
  }

  // ─── submitAnnotations → result(ok, groupId, beforeVersionId=sNNN, payload+cropBase64) + 两广播 ───
  let groupId = '';
  let beforeVersionId = '';
  {
    // 取当前两条 id
    const { broadcasts: bAll } = await routeOnce({ type: HTML_MSG.addAnnotation, reqId: reqId(), htmlPath: htmlA, annotation: { comment: '占位读 id', htmlSnippet: '', text: '', locator: { scrollY: 0, rect: { x: 0, y: 0, w: 0, h: 0 } } } });
    const cur = ev(bAll, HTML_MSG.annotationsChanged)!.annotations as Array<{ id: string; comment: string }>;
    const placeholder = cur.find((a) => a.comment === '占位读 id')!.id;
    await routeOnce({ type: HTML_MSG.removeAnnotation, reqId: reqId(), htmlPath: htmlA, annotationId: placeholder });
    const submitIds = cur.filter((a) => a.comment !== '占位读 id').map((a) => a.id);

    const { replies, broadcasts } = await routeOnce({
      type: HTML_MSG.submitAnnotations,
      reqId: reqId(),
      htmlPath: htmlA,
      annotationIds: submitIds,
      conversationId: 'cnv_h',
    });
    const res = replies[0] as Record<string, unknown>;
    assert(res?.type === HTML_MSG.submitAnnotationsResult && res.ok === true && res.htmlPath === htmlA, 'submit 回 html.submitAnnotations.result ok:true');
    groupId = res.groupId as string;
    beforeVersionId = res.beforeVersionId as string;
    assert(/^s\d+$/.test(beforeVersionId), 'beforeVersionId 是 fileHistory snapshot id（sNNN，非 deck vNNN）', beforeVersionId);
    const payload = res.payload as Array<{ annotationId: string; comment: string; cropBase64?: string }>;
    const p1 = payload.find((p) => p.annotationId === a1Id)!;
    assert(typeof p1.cropBase64 === 'string' && Buffer.from(p1.cropBase64, 'base64').equals(PNG_1x1), 'payload 带 crop 字节往返一致');
    // 广播：annotationsChanged（转 submitted）+ submissionChanged（修改中：afterVersionId 无）
    const sc = ev(broadcasts, HTML_MSG.submissionChanged);
    assert(!!sc && (sc.submission as { afterVersionId?: string }).afterVersionId === undefined, 'submit 后 submissionChanged=修改中');
    assert(!hasArtifactBroadcast(broadcasts), 'submit 无 artifact.* 广播漏出（C-2）');
    const anns = ev(broadcasts, HTML_MSG.annotationsChanged)!.annotations as Array<{ status: string }>;
    assert(anns.every((a) => a.status === 'submitted'), 'submit 后标注转 submitted');
  }

  // ─── 模拟 AI 改 html → manualFinalize（走核心 finalizeSubmission，旁路 deck 体检 C-1）───
  let afterVersionId = '';
  {
    await fs.writeFile(htmlA, HTML_B); // AI 改后
    const { replies, broadcasts } = await routeOnce({
      type: HTML_MSG.manualFinalize,
      reqId: reqId(),
      htmlPath: htmlA,
      groupId,
    });
    assert(replies[0]?.type === 'ack', 'manualFinalize 回 ack');
    const sc = ev(broadcasts, HTML_MSG.submissionChanged);
    afterVersionId = (sc!.submission as { afterVersionId?: string }).afterVersionId ?? '';
    assert(/^s\d+$/.test(afterVersionId), 'finalize 后 afterVersionId=sNNN（完成态）', afterVersionId);
    assert(!!ev(broadcasts, HTML_MSG.indexChanged), 'finalize 广播 html.indexChanged（热重载看改后）');
    assert(!hasArtifactBroadcast(broadcasts), 'finalize 无 artifact.* 广播漏出（C-1/C-2）');
  }

  // ─── enterCompare → 两临时文件落 html 同目录、内容=改前/改后；exitCompare 清掉 ───
  {
    const { replies } = await routeOnce({ type: HTML_MSG.enterCompare, reqId: reqId(), htmlPath: htmlA, groupId });
    const res = replies[0] as Record<string, unknown>;
    assert(res?.type === HTML_MSG.enterCompareResult, 'enterCompare 回 html.enterCompare.result');
    const beforeFile = res.beforeFile as string;
    const afterFile = res.afterFile as string;
    assert(beforeFile.startsWith('.a.html.compare-') && afterFile.startsWith('.a.html.compare-'), '对比临时文件带 .a.html 前缀防同目录撞', `${beforeFile} / ${afterFile}`);
    const beforeContent = await fs.readFile(join(dir, beforeFile), 'utf-8');
    const afterContent = await fs.readFile(join(dir, afterFile), 'utf-8');
    assert(beforeContent === HTML_A, '对比 before 文件=改前内容');
    assert(afterContent === HTML_B, '对比 after 文件=改后内容');

    await routeOnce({ type: HTML_MSG.exitCompare, reqId: reqId(), htmlPath: htmlA });
    const stillThere = await fs.readFile(join(dir, beforeFile), 'utf-8').then(() => true, () => false);
    assert(!stillThere, 'exitCompare 后对比临时文件被清掉');
  }

  // ─── saveSubmission（接受改后）→ 组解散、submissionChanged=null、htmlA 仍是改后 ───
  {
    const { replies, broadcasts } = await routeOnce({ type: HTML_MSG.saveSubmission, reqId: reqId(), htmlPath: htmlA, groupId });
    assert(replies[0]?.type === 'ack', 'saveSubmission 回 ack');
    const sc = ev(broadcasts, HTML_MSG.submissionChanged);
    assert(!!sc && sc.submission === null, 'save 后 submissionChanged=null（组解散）');
    assert((await fs.readFile(htmlA, 'utf-8')) === HTML_B, 'save 接受改后态，htmlA 不动');
  }

  // ─── 同目录 b.html sidecar 与 a.html 互不覆盖（脱 artifact 核心动机）───
  {
    const { broadcasts } = await routeOnce({ type: HTML_MSG.addAnnotation, reqId: reqId(), htmlPath: htmlB, annotation: { comment: 'b 的标注', htmlSnippet: '', text: '', locator: { scrollY: 0, rect: { x: 0, y: 0, w: 0, h: 0 } } } });
    const anns = ev(broadcasts, HTML_MSG.annotationsChanged)!.annotations as Array<{ comment: string }>;
    assert(anns.length === 1 && anns[0].comment === 'b 的标注', 'b.html 标注独立（不含 a.html 的）');
    assert(await fs.readFile(join(dir, '.b.html.annotations.json'), 'utf-8').then(() => true, () => false), 'b.html 落独立 sidecar');
    // a.html 的 sidecar 仍在、未被 b 覆盖（a 已 save 清空，但 sidecar 文件路径独立）
    assert((await fs.readFile(join(dir, '.a.html.annotations.json'), 'utf-8')).includes('"annotations"'), 'a.html sidecar 仍独立存在');
  }

  // ─── cancel 路径：submit→改→finalize→cancel → htmlB 内容回退到改前 ───
  {
    const beforeCancel = await fs.readFile(htmlB, 'utf-8');
    // 取 b 的标注 id
    const { broadcasts: b0 } = await routeOnce({ type: HTML_MSG.addAnnotation, reqId: reqId(), htmlPath: htmlB, annotation: { comment: '占位', htmlSnippet: '', text: '', locator: { scrollY: 0, rect: { x: 0, y: 0, w: 0, h: 0 } } } });
    const cur = ev(b0, HTML_MSG.annotationsChanged)!.annotations as Array<{ id: string }>;
    const ids = cur.map((a) => a.id);
    const { replies: sr } = await routeOnce({ type: HTML_MSG.submitAnnotations, reqId: reqId(), htmlPath: htmlB, annotationIds: ids, conversationId: 'cnv_b' });
    const bGroup = (sr[0] as Record<string, unknown>).groupId as string;
    await fs.writeFile(htmlB, '<!doctype html><html><body><h1>b 改坏了</h1></body></html>');
    await routeOnce({ type: HTML_MSG.manualFinalize, reqId: reqId(), htmlPath: htmlB, groupId: bGroup });
    const { broadcasts } = await routeOnce({ type: HTML_MSG.cancelSubmission, reqId: reqId(), htmlPath: htmlB, groupId: bGroup });
    assert(!!ev(broadcasts, HTML_MSG.indexChanged), 'cancel 广播 html.indexChanged（回退后热重载）');
    assert((await fs.readFile(htmlB, 'utf-8')) === beforeCancel, 'cancel 回退 htmlB 到改前内容');
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
