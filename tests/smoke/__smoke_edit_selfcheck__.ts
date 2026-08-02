/**
 * __smoke_edit_selfcheck__ —— 标注修改收尾工具的建议式体检回路（任务 9 决策 2，验目标问题本身）
 *
 * 钉的真风险（PRD 验收 1/2/3 + 决策 2/5）：AI 收尾**绕不过**客观体检；建议式可决定收工（含显式保留）；
 * 不死循环（撞上限强制定版 + Q2 信号）；abort 透传不被吞。全程 mock validateDeck、不打 Claude、
 * 不靠 AI 自愿调任何工具——直接驱动 artifact_finalize_submission 工具的 execute。
 *
 * 覆盖：
 *  - refeed：首轮有硬伤、未 ack → **回喂、不定版**（不调 core，版本不变、组仍修改中）；改干净后再调 → 才定版。
 *  - ack_keep：恒有硬伤；首次带 ack（attempts=0）→ 仍回喂（首次 ack 不生效）；再带 ack（attempts>0）→
 *    定版、**不**设 Q2 信号、返回含"向用户说明"提醒。
 *  - safety_valve：每轮换错（打地鼠）、AI 每轮都改不 ack → 撞 MAX_FINALIZE_ROUNDS 后强制定版 + 记 Q2 信号。
 *  - abort：体检进行中 abort → validateDeck 收到 signal、异常**透传不被吞**（不谎报 isError）。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDeck, resolveDeckPath } from '../../electron/main/deck/store';
import { initManifest, readManifest } from '../../electron/main/deck/history';
import { deckIndexPath } from '../../electron/main/deck/pathResolver';
import { addAnnotation, readAnnotations } from '../../electron/main/deck/annotations';
import {
  submitAnnotations,
  getByGroup,
  getSubmissionView,
  getByArtifact,
  __resetForTest as resetSubmissions,
} from '../../electron/main/deck/submissions';
import { makeFinalizeSubmissionTool } from '../../electron/main/agent/agentTools/finalizeSubmission';
import {
  __setValidateDeckForTest,
  type DeckValidationError,
} from '../../electron/main/deck/validateDeck';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

const HTML = `<!doctype html><html><body>
<section class="slide"><h1>A</h1></section>
</body></html>`;

const region = (comment: string) => ({
  comment,
  htmlSnippet: '',
  text: '',
  locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 }, pageIndex: 0 },
});

const err = (msg: string): DeckValidationError => ({ page: 1, kind: 'overflow', message: msg });

function makeCtx(overrides?: Partial<ToolContext>): { ctx: ToolContext; broadcasts: string[] } {
  const broadcasts: string[] = [];
  const ctx = makeToolContext({
    onArtifactSubmissionChanged: async (artifactId: string) => {
      broadcasts.push(artifactId);
    },
    ...overrides,
  });
  return { ctx, broadcasts };
}

const tool = makeFinalizeSubmissionTool();
let projectPath = '';

async function freshDeck(name: string, conversationId: string, dirty = true) {
  const deck = await createDeck({ projectId: 'prj_sc', projectPath, name });
  await initManifest(deck.id, HTML);
  const a1 = await addAnnotation(deck.id, region('改这里'));
  const r = await submitAnnotations({
    artifactId: deck.id,
    annotationIds: [a1.id],
    conversationId,
  });
  // 默认模拟"AI 改完 HTML 再收尾"——dirty index.html 贴近真实收尾。
  // 反向用例（标注全做不到）传 dirty=false：HTML 未动，验标注组仍照常定版、不被 noop 吞。
  if (dirty) {
    const deckPath = await resolveDeckPath(deck.id);
    await fs.writeFile(deckIndexPath(deckPath), HTML.replace('<h1>A</h1>', '<h1>A 改</h1>'), 'utf-8');
  }
  return { deck, groupId: r.groupId, beforeVersionId: r.beforeVersionId };
}

async function main() {
  resetSubmissions();
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'edit-selfcheck-'));
  projectPath = join(tmpRoot, 'prj');
  await fs.mkdir(projectPath, { recursive: true });

  // ─── refeed：绕不过体检 ───
  {
    let calls = 0;
    const restore = __setValidateDeckForTest(async () => {
      calls += 1;
      return calls === 1 ? [err('溢出 A'), err('溢出 B')] : [];
    });
    const { deck, groupId, beforeVersionId } = await freshDeck('refeed', 'cnv_refeed');
    const { ctx, broadcasts } = makeCtx();

    // 首轮：有 2 硬伤、未 ack → 回喂、不定版
    const r1 = await tool.execute({ group_id: groupId }, ctx);
    assert(r1.text?.includes('2 项') === true, 'refeed 首轮回喂清单（含项数）', r1.text);
    assert(r1.text?.includes('已收尾') !== true, 'refeed 首轮不报"已收尾"');
    assert(getByGroup(groupId)?.afterVersionId === undefined, 'refeed 首轮：组仍修改中（未定版）');
    assert(getByGroup(groupId)?.finalizeAttempts === 1, 'refeed 首轮：finalizeAttempts=1');
    assert((await readManifest(deck.id))!.currentVersion === beforeVersionId, 'refeed 首轮：版本未变（core 未调）');
    assert(broadcasts.length === 0, 'refeed 首轮：未广播（未定版）');

    // 改干净后再调 → 才定版
    const r2 = await tool.execute({ group_id: groupId }, ctx);
    assert(r2.text?.includes('已收尾') === true, 'refeed 改干净后：定版', r2.text);
    assert(getByGroup(groupId)?.afterVersionId !== undefined, 'refeed 改干净后：组转完成');
    assert((await readManifest(deck.id))!.currentVersion !== beforeVersionId, 'refeed 改干净后：落了新版本');
    assert(broadcasts.length === 1 && broadcasts[0] === deck.id, 'refeed 改干净后：广播一次');
    assert(getSubmissionView(deck.id)?.residualOnForceFinalize === undefined, 'refeed 干净定版：不设 Q2 信号');
    restore();
  }

  // ─── ack_keep：显式保留（首次 ack 不生效）───
  {
    const restore = __setValidateDeckForTest(async () => [err('用户要求保留的溢出')]);
    const { deck, groupId } = await freshDeck('ackkeep', 'cnv_ack');
    const { ctx } = makeCtx();

    // 首次带 ack（attempts=0）→ 仍回喂（守"先看清单再 ack"）
    const r1 = await tool.execute({ group_id: groupId, acknowledge_residual: true }, ctx);
    assert(r1.text?.includes('已收尾') !== true, 'ack_keep 首次 ack 不生效：仍回喂', r1.text);
    assert(getByGroup(groupId)?.afterVersionId === undefined, 'ack_keep 首次 ack：未定版');
    assert(getByGroup(groupId)?.finalizeAttempts === 1, 'ack_keep 首次 ack：attempts=1');

    // 再带 ack（attempts=1）→ 定版、不设 Q2、含"向用户说明"
    const r2 = await tool.execute({ group_id: groupId, acknowledge_residual: true }, ctx);
    assert(r2.text?.includes('已收尾') === true, 'ack_keep 再 ack：定版', r2.text);
    assert(r2.text?.includes('说明') === true, 'ack_keep 再 ack：提醒向用户说明残留');
    assert(getByGroup(groupId)?.afterVersionId !== undefined, 'ack_keep 再 ack：组转完成');
    assert(
      getSubmissionView(deck.id)?.residualOnForceFinalize === undefined,
      'ack_keep 主动保留：**不**设 Q2 信号（与安全阀区分）',
    );
    restore();
  }

  // ─── safety_valve：打地鼠撞上限强制定版 + Q2 ───
  {
    let calls = 0;
    const restore = __setValidateDeckForTest(async () => {
      calls += 1;
      return [err(`第 ${calls} 轮新冒出来的溢出`)]; // 每轮换错，恒非空
    });
    const { deck, groupId } = await freshDeck('valve', 'cnv_valve');
    const { ctx } = makeCtx();

    // MAX_FINALIZE_ROUNDS=3：前 3 次回喂（attempts 0→1→2→3），第 4 次撞 valve 强制定版
    for (let i = 1; i <= 3; i += 1) {
      const r = await tool.execute({ group_id: groupId }, ctx);
      assert(r.text?.includes('已收尾') !== true, `safety_valve 第 ${i} 轮：回喂不定版`);
    }
    assert(getByGroup(groupId)?.afterVersionId === undefined, 'safety_valve 3 轮后仍未定版');
    const r4 = await tool.execute({ group_id: groupId }, ctx);
    assert(r4.text?.includes('已收尾') === true, 'safety_valve 第 4 轮：撞上限强制定版', r4.text);
    assert(getByGroup(groupId)?.afterVersionId !== undefined, 'safety_valve：组转完成');
    assert(
      getSubmissionView(deck.id)?.residualOnForceFinalize === 1,
      'safety_valve：记 Q2 信号 residualOnForceFinalize=1',
      String(getSubmissionView(deck.id)?.residualOnForceFinalize),
    );
    assert(calls === 4, 'safety_valve：validateDeck 跑了 4 次（3 回喂 + 1 强制）', String(calls));
    restore();
  }

  // ─── abort：体检中取消 → 异常透传不被吞 ───
  {
    let sawSignal = false;
    const restore = __setValidateDeckForTest(async (_deckPath, signal) => {
      if (signal?.aborted) {
        sawSignal = true;
        throw new Error('aborted during validate'); // 模拟逐页渲染被取消时 SDK 抛错
      }
      return [];
    });
    const { groupId } = await freshDeck('abort', 'cnv_abort');
    const ac = new AbortController();
    ac.abort();
    const { ctx } = makeCtx({ abortSignal: ac.signal });

    let threw = false;
    let returnedIsError = false;
    try {
      const r = await tool.execute({ group_id: groupId }, ctx);
      returnedIsError = r.isError === true;
    } catch {
      threw = true;
    }
    assert(threw === true, 'abort：异常透传（execute throw，不吞成 isError）');
    assert(returnedIsError === false, 'abort：未谎报 isError 返回');
    assert(sawSignal === true, 'abort：validateDeck 收到 aborted signal');
    assert(getByGroup(groupId)?.afterVersionId === undefined, 'abort：未定版');
    restore();
  }

  // ─── noop 短路：纯文稿更新组（无标注）未改 HTML → 不落新版本 + 组被解散（决策 D-E，收窄后仅对无标注组生效）───
  {
    // validateDeck 故意返非空——验 noop 在 validateDeck **之前**短路（不该被调到、不该回喂清单）
    let validateCalls = 0;
    const restore = __setValidateDeckForTest(async () => {
      validateCalls += 1;
      return [err('不应被调到的体检')];
    });
    // 纯文稿更新组：annotationIds 空，直接成组、不改 index.html
    const deck = await createDeck({ projectId: 'prj_sc', projectPath, name: 'noop' });
    await initManifest(deck.id, HTML);
    const sub = await submitAnnotations({ artifactId: deck.id, annotationIds: [], conversationId: 'cnv_noop' });
    const groupId = sub.groupId;
    const beforeVersionId = sub.beforeVersionId;
    const { ctx, broadcasts } = makeCtx();

    // index.html == currentVersion（不 dirty）→ 直接收尾 = noop
    const r = await tool.execute({ group_id: groupId }, ctx);
    assert(r.text?.includes('已收尾') !== true, 'noop：不报"已收尾"（未定版）', r.text);
    assert(r.text?.includes('撤销') === true, 'noop：返回撤销提示', r.text);
    assert(r.isError !== true, 'noop：不是错误返回');
    assert(validateCalls === 0, 'noop：validateDeck 未被调（短路在体检之前）', String(validateCalls));
    assert((await readManifest(deck.id))!.currentVersion === beforeVersionId, 'noop：版本未变（未 commit）');
    assert(getByGroup(groupId) === undefined, 'noop：组被解散');
    assert(getByArtifact(deck.id) === undefined, 'noop：artifact 并发约束已释放');
    assert(broadcasts.length === 1 && broadcasts[0] === deck.id, 'noop：广播一次让前端清提交卡');
    restore();
  }

  // ─── 反向：标注组未改 HTML + 标注全做不到 → **不** noop，照常定版 + 失败标注落 failed 卡（Issue 1）───
  {
    // validateDeck 返 []（干净）——让收尾直接定版；验标注组绝不被 noop 吞
    let validateCalls = 0;
    const restore = __setValidateDeckForTest(async () => {
      validateCalls += 1;
      return [];
    });
    // 带标注组，但**不改** index.html（freshDeck dirty=false）——模拟 AI 判定标注做不到、HTML 没动
    const { deck, groupId, beforeVersionId } = await freshDeck('annfail', 'cnv_annfail', false);
    const failedAnnId = getByGroup(groupId)!.annotationIds[0];
    const { ctx, broadcasts } = makeCtx();

    // 传 results：该标注 ok:false → 应落 failed 卡，不被 noop 静默抹掉
    const r = await tool.execute(
      { group_id: groupId, results: { [failedAnnId]: { ok: false, reason: '与现有内容矛盾，做不到' } } },
      ctx,
    );
    assert(r.text?.includes('已收尾') === true, '标注全做不到：仍定版（不 noop）', r.text);
    assert(r.text?.includes('撤销') !== true, '标注全做不到：不报撤销（未走 noop）');
    assert(validateCalls > 0, '标注全做不到：走了 validateDeck（未在体检前短路）', String(validateCalls));
    assert(getByGroup(groupId)?.afterVersionId !== undefined, '标注全做不到：组转完成（未被解散）');
    assert((await readManifest(deck.id))!.currentVersion !== beforeVersionId, '标注全做不到：落了新版本');
    assert(broadcasts.length === 1 && broadcasts[0] === deck.id, '标注全做不到：广播一次');
    const anns = await readAnnotations(deck.id);
    const failedAnn = anns.find((a) => a.id === failedAnnId);
    assert(
      failedAnn?.status === 'failed' && failedAnn.failureMessage === '与现有内容矛盾，做不到',
      '标注全做不到：失败标注落 status=failed + failureMessage（未被 noop 吞）',
      JSON.stringify(failedAnn),
    );
    restore();
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
