/**
 * Artifact 收尾 smoke —— finalizeSubmission（5.2，核心）
 *
 * 钉的真风险（设计 §6.3）：
 * - finalize(2 ok + 1 failed) → afterVersionId 出、2 条清除、1 条 failed 留 reason、组完成
 * - finalize 对已不存在的 groupId → no-op 不抛
 * - **AI 不调 finalize**（submit 后什么都不做）→ Submission 仍修改中、标注仍 submitted、
 *   一段时间后状态不变（无任何自动清除/超时——证明不卡死也不瞎清）
 * - manualFinalize（results 空）→ 全成功清除 + 组完成
 * - 注入提示：有 pending submission 时 buildRuntimeContext 含收尾提示，完成后消失
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
  finalizeSubmission,
  stopSubmission,
  getByGroup,
  __resetForTest as resetSubmissions,
} from '../../electron/main/deck/submissions';
import { buildRuntimeContext } from '../../electron/main/agent/hooks';

/** buildRuntimeContext 的 ownerId/agentId 是必填（计划清单按对话取盘）——测试里给一对固定值即可 */
const OWNER = { ownerId: 'o', agentId: 'a' };
import { makeFinalizeSubmissionTool } from '../../electron/main/agent/agentTools/finalizeSubmission';
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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  resetSubmissions();
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'artifact-finalize-'));
  const projectPath = join(tmpRoot, 'prj');
  await fs.mkdir(projectPath, { recursive: true });

  // ─── case 1: finalize(2 ok + 1 failed) ───
  {
    const deck = await createDeck({ projectId: 'prj_f', projectPath, name: 'fin1' });
    await initManifest(deck.id, HTML);
    const a1 = await addAnnotation(deck.id, region('做到一'));
    const a2 = await addAnnotation(deck.id, region('做到二'));
    const a3 = await addAnnotation(deck.id, region('做不到三'));
    const r = await submitAnnotations({
      artifactId: deck.id,
      annotationIds: [a1.id, a2.id, a3.id],
      conversationId: 'cnv_f1',
    });
    const beforeVersion = (await readManifest(deck.id))!.currentVersion;

    const fr = await finalizeSubmission(r.groupId, {
      [a1.id]: { ok: true },
      [a3.id]: { ok: false, reason: '页面里没有这个元素' },
      // a2 未提及 → 默认成功
    });
    assert(!fr.noop && !!fr.afterVersionId, 'finalize 返回 afterVersionId');
    const manifest = await readManifest(deck.id);
    assert(manifest!.currentVersion === fr.afterVersionId, 'afterVersionId = 新 currentVersion');
    assert(fr.afterVersionId !== beforeVersion, 'afterVersionId 是新落的版本（commit 发生）');

    const all = await readAnnotations(deck.id);
    assert(all.find((x) => x.id === a1.id) === undefined, 'a1 (ok) 已清除');
    assert(all.find((x) => x.id === a2.id) === undefined, 'a2 (未提及默认成功) 已清除');
    const fa3 = all.find((x) => x.id === a3.id);
    assert(
      fa3?.status === 'failed' && fa3.failureMessage === '页面里没有这个元素',
      'a3 (failed) 留组内 + reason',
    );
    // 组转完成（有 afterVersionId）
    assert(getByGroup(r.groupId)?.afterVersionId === fr.afterVersionId, '组转完成（afterVersionId 已设）');
  }

  // ─── case 2: finalize 对已不存在的 groupId → no-op 不抛 ───
  {
    let threw = false;
    let fr;
    try {
      fr = await finalizeSubmission('grp_doesnotexist', { ann_x: { ok: true } });
    } catch {
      threw = true;
    }
    assert(!threw && fr?.noop === true, 'finalize 不存在 groupId → no-op 不抛');
  }

  // ─── case 3: AI 不调 finalize → 状态不变、不卡死、不瞎清 ───
  {
    const deck = await createDeck({ projectId: 'prj_f', projectPath, name: 'fin3' });
    await initManifest(deck.id, HTML);
    const a1 = await addAnnotation(deck.id, region('等 AI 改'));
    const r = await submitAnnotations({
      artifactId: deck.id,
      annotationIds: [a1.id],
      conversationId: 'cnv_f3',
    });
    // 注入提示存在（有 pending submission）
    const ctxBefore = await buildRuntimeContext('cnv_f3', OWNER);
    assert(ctxBefore.includes('artifact_finalize_submission'), '有 pending 时运行时上下文含收尾提示');
    assert(ctxBefore.includes(r.groupId), '收尾提示带 groupId');
    // 钉本次改动的目标：收尾提示带 deck 源文件真实绝对路径，省得 LLM 自己猜路径越界
    assert(
      ctxBefore.includes(`源文件 ${join(deck.path, 'index.html')}`),
      '收尾提示带 deck 源文件绝对路径',
    );
    // 钉本次修复：标注修改是"亲自动手"的活——提示给出执行指引（read_file 读源文件自己改），
    // 并显式否掉"提交提案等自动派发"误导，免得 LLM 套用新建流程卡在叙述循环不动手
    assert(
      ctxBefore.includes('亲自动手') && ctxBefore.includes('read_file'),
      '收尾提示给出执行指引（亲自动手 + read_file 读源文件自己改）',
    );
    assert(
      ctxBefore.includes('propose_deck_create'),
      '收尾提示显式否掉"提交提案等自动派发"误导（编辑无提案这一步）',
    );

    // AI 什么都不做——等一段时间
    await delay(300);

    // 状态不变：Submission 仍修改中、标注仍 submitted、无任何自动清除/超时
    const sub = getByGroup(r.groupId);
    assert(!!sub && sub.afterVersionId === undefined, 'AI 不调 finalize：Submission 仍修改中');
    const all = await readAnnotations(deck.id);
    const sa1 = all.find((x) => x.id === a1.id);
    assert(
      sa1?.status === 'submitted' && sa1.groupId === r.groupId,
      'AI 不调 finalize：标注仍 submitted（没被自动清除）',
    );
    assert(all.length === 1, 'AI 不调 finalize：没有任何瞎清除');
    // manifest 没有凭空多出版本（没自动 commit）
    const manifest = await readManifest(deck.id);
    assert(manifest!.currentVersion === r.beforeVersionId, 'AI 不调 finalize：没有自动 commit 新版本');
  }

  // ─── case 4: manualFinalize（results 空）→ 全成功清除 + 组完成 ───
  {
    const deck = await createDeck({ projectId: 'prj_f', projectPath, name: 'fin4' });
    await initManifest(deck.id, HTML);
    const a1 = await addAnnotation(deck.id, region('手动完成一'));
    const a2 = await addAnnotation(deck.id, region('手动完成二'));
    const r = await submitAnnotations({
      artifactId: deck.id,
      annotationIds: [a1.id, a2.id],
      conversationId: 'cnv_f4',
    });
    // results 空 = 全成功（与 manualFinalize 走同一函数）
    const fr = await finalizeSubmission(r.groupId, {});
    assert(!fr.noop && !!fr.afterVersionId, 'manualFinalize（空 results）落新版本');
    const all = await readAnnotations(deck.id);
    assert(all.length === 0, 'manualFinalize：全部标注成功清除');
    assert(getByGroup(r.groupId)?.afterVersionId === fr.afterVersionId, 'manualFinalize：组转完成');

    // 完成后运行时上下文不再提示该组（afterVersionId 已设）
    const ctxAfter = await buildRuntimeContext('cnv_f4', OWNER);
    assert(!ctxAfter.includes(r.groupId), '完成后运行时上下文不再提示该组');
  }

  // ─── case 5: AI 收尾工具 → onArtifactSubmissionChanged 回调（接 ToolContext 广播）───
  {
    const tool = makeFinalizeSubmissionTool();
    const recorded: string[] = [];
    // 只需 onArtifactSubmissionChanged，其余字段由工厂补齐默认
    const ctx = makeToolContext({
      onArtifactSubmissionChanged: async (artifactId: string) => {
        recorded.push(artifactId);
      },
    });

    // 5a: 非 noop finalize → 回调被调且传对 artifactId
    const deck = await createDeck({ projectId: 'prj_f', projectPath, name: 'fin5' });
    await initManifest(deck.id, HTML);
    const a1 = await addAnnotation(deck.id, region('AI 收尾'));
    const r = await submitAnnotations({
      artifactId: deck.id,
      annotationIds: [a1.id],
      conversationId: 'cnv_f5',
    });
    // 模拟 AI 改完 HTML（dirty）——贴近真实收尾场景（标注组不再走 noop，此处仅为真实改动）
    const deckPath = await resolveDeckPath(deck.id);
    await fs.writeFile(deckIndexPath(deckPath), HTML.replace('<h1>A</h1>', '<h1>A 改</h1>'), 'utf-8');
    const beforeVersion = (await readManifest(deck.id))!.currentVersion;
    const res = await tool.execute({ group_id: r.groupId }, ctx);
    assert(!('isError' in res) || !res.isError, '工具收尾成功（无 isError）');
    assert(
      recorded.length === 1 && recorded[0] === deck.id,
      '非 noop finalize：回调被调一次且 artifactId 正确',
      recorded.join(','),
    );
    assert((await readManifest(deck.id))!.currentVersion !== beforeVersion, '非 noop finalize：落了新版本');

    // 5b: 对已解散 groupId（先 stopSubmission）→ noop，回调不被调
    const deck2 = await createDeck({ projectId: 'prj_f', projectPath, name: 'fin5b' });
    await initManifest(deck2.id, HTML);
    const b1 = await addAnnotation(deck2.id, region('停止后再收尾'));
    const r2 = await submitAnnotations({
      artifactId: deck2.id,
      annotationIds: [b1.id],
      conversationId: 'cnv_f5b',
    });
    await stopSubmission(r2.groupId);
    recorded.length = 0;
    const res2 = await tool.execute({ group_id: r2.groupId }, ctx);
    assert(!('isError' in res2) || !res2.isError, '已解散组工具静默成功（无 isError）');
    assert(recorded.length === 0, 'noop finalize：回调不被调');
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
