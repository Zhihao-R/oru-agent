/**
 * __smoke_manual_finalize_no_check__ —— 用户手动「标记完成」不跑体检（任务 9 决策 1/3，PRD 验收 5）
 *
 * 钉的真风险：体检挂在 AI 收尾**工具**里、不挂进 core finalizeSubmission——所以走 core 的路径
 * （router `artifact.manualFinalize` → 直接 import core，不过 AI 工具）天然不触发 validateDeck。
 * 用 spy 钉 validateDeck 一次都不被调；同时正常定版。对照组：过 AI 工具会调 validateDeck。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDeck, resolveDeckPath } from '../../electron/main/deck/store';
import { deckIndexPath } from '../../electron/main/deck/pathResolver';
import { initManifest, readManifest } from '../../electron/main/deck/history';
import { addAnnotation, readAnnotations } from '../../electron/main/deck/annotations';
import {
  submitAnnotations,
  finalizeSubmission,
  getByGroup,
  __resetForTest as resetSubmissions,
} from '../../electron/main/deck/submissions';
import { makeFinalizeSubmissionTool } from '../../electron/main/agent/agentTools/finalizeSubmission';
import { __setValidateDeckForTest } from '../../electron/main/deck/validateDeck';
import { makeToolContext } from '../helpers/toolContext';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

const HTML = `<!doctype html><html><body><section class="slide"><h1>A</h1></section></body></html>`;
const region = (comment: string) => ({
  comment,
  htmlSnippet: '',
  text: '',
  locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex: 0 },
});

async function main() {
  resetSubmissions();
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'manual-finalize-'));
  const projectPath = join(tmpRoot, 'prj');
  await fs.mkdir(projectPath, { recursive: true });

  let validateCalls = 0;
  // 体检永远报硬伤——若手动路径误跑体检，会被卡住/计数；正确行为是它根本不被调。
  const restore = __setValidateDeckForTest(async () => {
    validateCalls += 1;
    return [{ page: 1, kind: 'overflow', message: '若被调到这就错了' }];
  });

  // ─── 手动完成：直接走 core finalizeSubmission（router.artifact.manualFinalize 的实现）───
  {
    const deck = await createDeck({ projectId: 'prj_m', projectPath, name: 'manual' });
    await initManifest(deck.id, HTML);
    const a1 = await addAnnotation(deck.id, region('手动完成'));
    const r = await submitAnnotations({ artifactId: deck.id, annotationIds: [a1.id], conversationId: 'cnv_m' });
    const beforeVersion = (await readManifest(deck.id))!.currentVersion;

    // 手动完成 = results 空、直接调 core（与 router 一致）
    const fr = await finalizeSubmission(r.groupId, {});
    assert(validateCalls === 0, '手动完成：validateDeck 一次都没被调（体检不挂 core）', String(validateCalls));
    assert(!fr.noop && !!fr.afterVersionId, '手动完成：仍正常定版（落新版本）');
    assert((await readManifest(deck.id))!.currentVersion !== beforeVersion, '手动完成：版本已变');
    assert((await readAnnotations(deck.id)).length === 0, '手动完成：标注全成功清除');
    assert(getByGroup(r.groupId)?.afterVersionId === fr.afterVersionId, '手动完成：组转完成');
    assert(getByGroup(r.groupId)?.residualOnForceFinalize === undefined, '手动完成：不设 Q2 信号');
  }

  // ─── 对照组：过 AI 工具就会跑体检（证明 spy 本身有效、差异来自路径而非 mock 失灵）───
  {
    const deck = await createDeck({ projectId: 'prj_m', projectPath, name: 'viatool' });
    await initManifest(deck.id, HTML);
    const a1 = await addAnnotation(deck.id, region('过工具'));
    const r = await submitAnnotations({ artifactId: deck.id, annotationIds: [a1.id], conversationId: 'cnv_m2' });
    // 模拟 AI 改完 HTML——贴近真实收尾场景（标注组不再走 noop，此处仅为真实改动）
    const deckPath = await resolveDeckPath(deck.id);
    await fs.writeFile(deckIndexPath(deckPath), HTML.replace('<h1>A</h1>', '<h1>A 改</h1>'), 'utf-8');
    const tool = makeFinalizeSubmissionTool();
    const ctx = makeToolContext({ onArtifactSubmissionChanged: async () => {} });
    await tool.execute({ group_id: r.groupId }, ctx);
    assert(validateCalls === 1, '对照组：过 AI 工具会跑一次体检（spy 有效）', String(validateCalls));
  }

  restore();

  const failed = RESULTS.filter((x) => !x.ok);
  console.log('');
  console.log(`Total: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.error(` - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke fatal error:', e);
  process.exit(1);
});
