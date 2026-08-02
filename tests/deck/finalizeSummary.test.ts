/**
 * finalizeSubmission 的收尾摘要来源（任务 3.1 决策 D-D）
 *
 * core finalizeSubmission 可选第三参 summaryOverride：传入 → 版本 summary 用它（据文稿更新流概述变更重点）；
 * 不传 → 仍走 deriveSummary（标注流；空标注 → 'AI 按标注修改'）。
 *
 * ORU_DIR 在任何业务 import 前重定向到 tmpdir；所有业务模块走动态 await import（避免 paths 锁死）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-finalize-summary-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const HTML = `<!doctype html><html><body>
<section class="slide"><h1>A</h1></section>
</body></html>`;

let projectPath = '';

async function freshGroup(name: string) {
  const { createDeck } = await import('../../electron/main/deck/store');
  const { initManifest } = await import('../../electron/main/deck/history');
  const { submitAnnotations } = await import('../../electron/main/deck/submissions');

  const deck = await createDeck({ projectId: 'prj_fs', projectPath, name });
  await initManifest(deck.id, HTML);
  // 据文稿更新流无标注：直接成组。core finalizeSubmission 从不查 isDirty（只工具层查），
  // 无条件 commit，dirty 与否都落版本——故无需在此制造 dirty。
  const r = await submitAnnotations({ artifactId: deck.id, annotationIds: [], conversationId: 'cnv_fs' });
  return { deck, groupId: r.groupId };
}

describe('finalizeSubmission — 收尾摘要来源（summaryOverride）', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
    projectPath = join(ORU_DIR, 'prj');
    await fs.mkdir(projectPath, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('传 summaryOverride → 版本 summary 用它（据文稿更新流）', async () => {
    const { finalizeSubmission } = await import('../../electron/main/deck/submissions');
    const { readManifest } = await import('../../electron/main/deck/history');
    const { deck, groupId } = await freshGroup('override');

    const r = await finalizeSubmission(groupId, {}, '重写了开场');
    expect(r.noop).toBe(false);

    const manifest = await readManifest(deck.id);
    const latest = manifest!.versions.find((v) => v.id === r.afterVersionId);
    expect(latest?.summary).toBe('重写了开场');
  });

  it('不传 summaryOverride + 空标注 → 仍走 deriveSummary 默认文案', async () => {
    const { finalizeSubmission } = await import('../../electron/main/deck/submissions');
    const { readManifest } = await import('../../electron/main/deck/history');
    const { deck, groupId } = await freshGroup('derive');

    const r = await finalizeSubmission(groupId, {});
    expect(r.noop).toBe(false);

    const manifest = await readManifest(deck.id);
    const latest = manifest!.versions.find((v) => v.id === r.afterVersionId);
    expect(latest?.summary).toBe('AI 按标注修改');
  });

  it('幂等：已完成组（afterVersionId 已有）再 finalize → noop、不产第二个 ai 版本（M1）', async () => {
    const { finalizeSubmission } = await import('../../electron/main/deck/submissions');
    const { listVersions } = await import('../../electron/main/deck/history');
    const { deck, groupId } = await freshGroup('idempotent');

    const r1 = await finalizeSubmission(groupId, {});
    expect(r1.noop).toBe(false);
    const afterFirst = await listVersions(deck.id);
    const r2 = await finalizeSubmission(groupId, {}); // 连续收尾
    expect(r2.noop).toBe(true); // 守卫拦住，不再 commit
    expect(r2.afterVersionId).toBe(r1.afterVersionId); // 回头指向已定的 after
    expect((await listVersions(deck.id)).length).toBe(afterFirst.length); // 无第二个 ai 版本
  });
});
