/**
 * 提交中断「已中断」后端（项目B 第二期 Task9，PRD §六-6）。
 *
 * - submit 落中断记录；正常解散（finalize/stop/cancel）清记录。
 * - reconcile 改写：孤儿 submitted **有**记录→保留 submitted（已中断，不降级）；**无**记录→老降级。
 * - getInterruptedView：重建「已中断」视图（interrupted + annotationIds + beforeVersionId + conversationId）。
 * - discardInterruptedGroup（退回改前）：checkout 到 beforeVersionId + 标注降级 + 清记录。
 *
 * ORU_DIR 在业务 import 前重定向；业务模块动态 import。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-interruption-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const HTML = `<!doctype html><html><body><section class="slide"><h1>A</h1></section></body></html>`;
const HTML2 = `<!doctype html><html><body><section class="slide"><h1>CHANGED</h1></section></body></html>`;

let projectPath = '';

const region = (comment: string) => ({
  comment,
  htmlSnippet: '',
  text: '',
  locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex: 0 },
});

async function freshDeck(name: string): Promise<string> {
  const { createDeck } = await import('../../electron/main/deck/store');
  const { initManifest } = await import('../../electron/main/deck/history');
  const deck = await createDeck({ projectId: 'prj_int', projectPath, name });
  await initManifest(deck.id, HTML);
  return deck.id;
}

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

describe('提交中断「已中断」', () => {
  it('submit 落中断记录（groupId/conversationId/beforeVersionId）', async () => {
    const { submitAnnotations } = await import('../../electron/main/deck/submissions');
    const { addAnnotation } = await import('../../electron/main/deck/annotations');
    const { getInterruption } = await import('../../electron/main/deck/interruptionStore');
    const id = await freshDeck('rec');
    const a1 = await addAnnotation(id, region('改'));
    const r = await submitAnnotations({ artifactId: id, annotationIds: [a1.id], conversationId: 'cnv_1' });
    const rec = await getInterruption(id, r.groupId);
    expect(rec).toEqual({ groupId: r.groupId, conversationId: 'cnv_1', beforeVersionId: r.beforeVersionId });
  });

  it('reconcile：有记录→保留 submitted（已中断不降级）；无记录→老降级 pending', async () => {
    const { submitAnnotations, reconcileOrphanedSubmissions, __resetForTest } = await import(
      '../../electron/main/deck/submissions'
    );
    const { addAnnotation, readAnnotations } = await import('../../electron/main/deck/annotations');
    const id = await freshDeck('reconcile');
    const a1 = await addAnnotation(id, region('改'));
    const r = await submitAnnotations({ artifactId: id, annotationIds: [a1.id], conversationId: 'cnv_2' });
    // 模拟崩溃：清内存组（记录仍在盘）
    __resetForTest();
    await reconcileOrphanedSubmissions(id);
    const after = await readAnnotations(id);
    const kept = after.find((a) => a.id === a1.id);
    expect(kept?.status).toBe('submitted'); // 有中断记录 → 保留 submitted
    expect(kept?.groupId).toBe(r.groupId);

    // 对照：手动删记录后 reconcile → 老降级
    const { clearInterruption } = await import('../../electron/main/deck/interruptionStore');
    await clearInterruption(id, r.groupId);
    await reconcileOrphanedSubmissions(id);
    const after2 = await readAnnotations(id);
    expect(after2.find((a) => a.id === a1.id)?.status).toBe('pending'); // 无记录 → 降级
  });

  it('getInterruptedView：重建已中断视图', async () => {
    const { submitAnnotations, getInterruptedView, __resetForTest } = await import(
      '../../electron/main/deck/submissions'
    );
    const { addAnnotation } = await import('../../electron/main/deck/annotations');
    const id = await freshDeck('view');
    const a1 = await addAnnotation(id, region('改'));
    const r = await submitAnnotations({ artifactId: id, annotationIds: [a1.id], conversationId: 'cnv_3' });
    __resetForTest(); // 崩溃
    const view = await getInterruptedView(id);
    expect(view?.interrupted).toBe(true);
    expect(view?.groupId).toBe(r.groupId);
    expect(view?.annotationIds).toEqual([a1.id]);
    expect(view?.beforeVersionId).toBe(r.beforeVersionId);
    expect(view?.conversationId).toBe('cnv_3');
  });

  it('正常解散（cancel）清中断记录', async () => {
    const { submitAnnotations, finalizeSubmission, cancelSubmission } = await import(
      '../../electron/main/deck/submissions'
    );
    const { addAnnotation } = await import('../../electron/main/deck/annotations');
    const { getInterruption } = await import('../../electron/main/deck/interruptionStore');
    const id = await freshDeck('clear');
    const a1 = await addAnnotation(id, region('改'));
    const r = await submitAnnotations({ artifactId: id, annotationIds: [a1.id], conversationId: 'cnv_4' });
    await finalizeSubmission(r.groupId, {});
    await cancelSubmission(r.groupId);
    expect(await getInterruption(id, r.groupId)).toBeUndefined();
  });

  it('多条残留记录：getInterruptedView 取最新；reconcile prune 清掉换组后的失效记录', async () => {
    const { submitAnnotations, getInterruptedView, reconcileOrphanedSubmissions, __resetForTest } =
      await import('../../electron/main/deck/submissions');
    const { addAnnotation } = await import('../../electron/main/deck/annotations');
    const { listInterruptions } = await import('../../electron/main/deck/interruptionStore');
    const id = await freshDeck('multi');
    const a1 = await addAnnotation(id, region('改'));
    // 第一次提交 → 崩溃（记录1 留盘）
    const r1 = await submitAnnotations({ artifactId: id, annotationIds: [a1.id], conversationId: 'cnv_a' });
    __resetForTest();
    // 「继续」式重提交：同一标注换新组、新对话（记录2）。旧记录1 仍在盘
    const r2 = await submitAnnotations({ artifactId: id, annotationIds: [a1.id], conversationId: 'cnv_b' });
    expect(r2.groupId).not.toBe(r1.groupId);
    __resetForTest(); // 再崩溃
    // 两条记录：getInterruptedView 取最新（r2 / cnv_b）
    const view = await getInterruptedView(id);
    expect(view?.groupId).toBe(r2.groupId);
    expect(view?.conversationId).toBe('cnv_b');
    // reconcile：a1 现以 r2.groupId submitted（有记录保留）；r1 记录的标注已换组 → 被 prune
    await reconcileOrphanedSubmissions(id);
    const remaining = (await listInterruptions(id)).map((r) => r.groupId);
    expect(remaining).toEqual([r2.groupId]); // 失效的 r1 记录清掉
  });

  it('discardInterruptedGroup（退回改前）：checkout beforeVersion + 标注降级 + 清记录', async () => {
    const { submitAnnotations, discardInterruptedGroup, __resetForTest } = await import(
      '../../electron/main/deck/submissions'
    );
    const { addAnnotation, readAnnotations } = await import('../../electron/main/deck/annotations');
    const { deckIndexPath } = await import('../../electron/main/deck/pathResolver');
    const { resolveDeckPath } = await import('../../electron/main/deck/store');
    const { getInterruption } = await import('../../electron/main/deck/interruptionStore');
    const id = await freshDeck('discard');
    const a1 = await addAnnotation(id, region('改'));
    const r = await submitAnnotations({ artifactId: id, annotationIds: [a1.id], conversationId: 'cnv_5' });
    const deckPath = await resolveDeckPath(id);
    // 模拟 AI 改了一半 + 崩溃
    await fs.writeFile(deckIndexPath(deckPath), HTML2, 'utf-8');
    __resetForTest();

    const ok = await discardInterruptedGroup(id, r.groupId);
    expect(ok).toBe(true);
    // index.html 回退到改前（beforeVersion = 初始 HTML）
    expect(await fs.readFile(deckIndexPath(deckPath), 'utf-8')).toBe(HTML);
    // 标注降级 pending、记录清掉
    expect((await readAnnotations(id)).find((a) => a.id === a1.id)?.status).toBe('pending');
    expect(await getInterruption(id, r.groupId)).toBeUndefined();
  });
});
