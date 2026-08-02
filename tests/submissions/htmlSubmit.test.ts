/**
 * html 提交流跑在共用内核上（项目B 第三期 Task12）。
 *
 * html 不伪装成 deck：submitAnnotationsTo(htmlTarget(htmlPath)) 走与 deck 同一套
 * submit/finalize/cancel/save。验：before/after 派生、annotations 状态机、checkout 回退、
 * pin/unpin 接线（裁定 A：html before/after 在被引用期间进 fileHistory.pinned）。
 *
 * ORU_DIR 在 import 前重定向。每个 it 前 __resetForTest 清内存组。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-htmlsubmit-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const HTML_A = '<!doctype html><html><body><h1>A</h1></body></html>';
const HTML_B = '<!doctype html><html><body><h1>B 改后</h1></body></html>';

let dir = '';
beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  dir = join(ORU_DIR, 'docs');
  await fs.mkdir(dir, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  const { __resetForTest } = await import('../../electron/main/deck/submissions');
  __resetForTest();
});

/** 读 html fileHistory store 的 pinned 集（验 pin/unpin 接线）。 */
async function pinnedOf(htmlPath: string): Promise<string[]> {
  const { createHash } = await import('node:crypto');
  const { historyDir } = await import('../../electron/main/runtime/paths');
  const { getCurrentOwnerId } = await import('../../electron/main/identity/getCurrentOwnerId');
  const slug = createHash('sha256').update(resolve(htmlPath), 'utf-8').digest('hex').slice(0, 32);
  try {
    const store = JSON.parse(await fs.readFile(join(historyDir(getCurrentOwnerId()), slug, 'manifest.json'), 'utf-8'));
    return store.pinned ?? [];
  } catch {
    return [];
  }
}

async function setup(name: string): Promise<{ htmlPath: string; ids: string[] }> {
  const htmlPath = join(dir, name);
  await fs.writeFile(htmlPath, HTML_A);
  const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
  const { addAnnotationAt } = await import('../../electron/main/deck/annotations');
  const loc = htmlAnnotationLocation(htmlPath);
  const a1 = await addAnnotationAt(loc, { comment: '改标题', htmlSnippet: '<h1>A</h1>', text: 'A' });
  const a2 = await addAnnotationAt(loc, { comment: '再改一处', htmlSnippet: '', text: '' });
  return { htmlPath, ids: [a1.id, a2.id] };
}

describe('html 提交流共用内核', () => {
  it('submit：派生 before、标注转 submitted、payload 带评论、before 被 pin', async () => {
    const { htmlPath, ids } = await setup('submit.html');
    const { htmlTarget } = await import('../../electron/main/submissions/target');
    const { submitAnnotationsTo, getByArtifact } = await import('../../electron/main/deck/submissions');
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { readAnnotationsAt } = await import('../../electron/main/deck/annotations');

    const r = await submitAnnotationsTo(htmlTarget(htmlPath), ids, 'conv1');
    expect(r.beforeVersionId).toMatch(/^s\d+$/); // html before = fileHistory snapshot id
    expect(r.payload.map((p) => p.comment)).toEqual(['改标题', '再改一处']);
    // 标注转 submitted + 打 groupId
    const anns = await readAnnotationsAt(htmlAnnotationLocation(htmlPath));
    expect(anns.every((a) => a.status === 'submitted' && a.groupId === r.groupId)).toBe(true);
    // 活跃组按 key=resolve(htmlPath) 可查
    expect(getByArtifact(resolve(htmlPath))?.groupId).toBe(r.groupId);
    // before 被 pin（裁定 A）
    expect(await pinnedOf(htmlPath)).toContain(r.beforeVersionId);
  });

  it('一文件同时至多一个未完成组（并发约束）', async () => {
    const { htmlPath, ids } = await setup('inprogress.html');
    const { htmlTarget } = await import('../../electron/main/submissions/target');
    const { submitAnnotationsTo } = await import('../../electron/main/deck/submissions');
    await submitAnnotationsTo(htmlTarget(htmlPath), [ids[0]], 'conv1');
    await expect(submitAnnotationsTo(htmlTarget(htmlPath), [ids[1]], 'conv1')).rejects.toThrow(
      /SUBMISSION_IN_PROGRESS|未完成/,
    );
  });

  it('finalize → save：落 after、清成功标注、after 也 pin，save 后 unpin', async () => {
    const { htmlPath, ids } = await setup('finalize.html');
    const { htmlTarget } = await import('../../electron/main/submissions/target');
    const { submitAnnotationsTo, finalizeSubmission, saveSubmission } = await import(
      '../../electron/main/deck/submissions'
    );
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { readAnnotationsAt } = await import('../../electron/main/deck/annotations');

    const r = await submitAnnotationsTo(htmlTarget(htmlPath), ids, 'conv1');
    await fs.writeFile(htmlPath, HTML_B); // 模拟 AI 改
    const fin = await finalizeSubmission(r.groupId);
    expect(fin.noop).toBe(false);
    expect(fin.afterVersionId).toMatch(/^s\d+$/);
    expect((await pinnedOf(htmlPath)).sort()).toEqual([r.beforeVersionId, fin.afterVersionId].sort());
    // 成功标注被清除
    expect(await readAnnotationsAt(htmlAnnotationLocation(htmlPath))).toHaveLength(0);

    await saveSubmission(r.groupId);
    expect(await pinnedOf(htmlPath)).toEqual([]); // save 解散 → before/after unpin
  });

  it('finalize → cancel：checkout 回 before、htmlPath 回退、unpin（完成态取消，真实流）', async () => {
    const { htmlPath, ids } = await setup('cancel.html');
    const { htmlTarget } = await import('../../electron/main/submissions/target');
    const { submitAnnotationsTo, finalizeSubmission, cancelSubmission } = await import(
      '../../electron/main/deck/submissions'
    );
    const r = await submitAnnotationsTo(htmlTarget(htmlPath), ids, 'conv1');
    await fs.writeFile(htmlPath, HTML_B); // AI 改坏
    await finalizeSubmission(r.groupId); // 成功标注清除，进「完成」态
    await cancelSubmission(r.groupId); // 看了对比觉得不行 → 取消
    expect(await fs.readFile(htmlPath, 'utf-8')).toBe(HTML_A); // 回退改前
    expect(await pinnedOf(htmlPath)).toEqual([]); // unpin
  });

  it('stop（修改中撤回）：标注降回 pending + 清 groupId、unpin before', async () => {
    const { htmlPath, ids } = await setup('stop.html');
    const { htmlTarget } = await import('../../electron/main/submissions/target');
    const { submitAnnotationsTo, stopSubmission } = await import('../../electron/main/deck/submissions');
    const { htmlAnnotationLocation } = await import('../../electron/main/annotations/location');
    const { readAnnotationsAt } = await import('../../electron/main/deck/annotations');

    const r = await submitAnnotationsTo(htmlTarget(htmlPath), ids, 'conv1');
    await stopSubmission(r.groupId); // 修改中撤回
    const anns = await readAnnotationsAt(htmlAnnotationLocation(htmlPath));
    expect(anns.every((a) => a.status === 'pending' && a.groupId === undefined)).toBe(true);
    expect(await pinnedOf(htmlPath)).toEqual([]); // before unpin
  });
});
