/**
 * Submission 内存模型（提交组）
 *
 * 提交一批标注时在"提交"瞬间成组（修改中），完成靠 AI 显式收尾工具
 * （commit + 打标）派生 afterVersionId。组的两态由 afterVersionId 派生，
 * 不另设 state 字段：无 → 「修改中」，有 → 「完成」（设计 §3.2）。
 *
 * 只活在进程内存（崩溃重启即丢，退化处理见设计 §6.6——加载时孤儿 submitted
 * 降回 pending）。每个 target 至多一个**未完成**（afterVersionId 未设）的
 * Submission——并发约束（设计 §6.4）由 createSubmission 在内存层守住。
 *
 * 提交内核通过 SubmissionTarget 操作标注/版本/中断/pin（项目B 第三期 Task12）——deck 与 html
 * 共用 submit/finalize/cancel/save/stop/reconcile/中断一条流；deck-facing 导出（submitAnnotations
 * (artifactId,…)/finalize(groupId,…) 等）保签名，内部解析 deckTarget，行为零回归。
 */

import type { SubmissionTarget } from '../submissions/target';
import { deckTarget } from '../submissions/target';

export type Submission = {
  groupId: string;
  /** byTarget 键（deck:artifactId / html:resolve(htmlPath)）——返回值/焦点解析/会话过滤用。
   *  注意是 target.key 不是 deck artifactId：html 下它是绝对路径，故叫 key 不叫 artifactId（M-2）。 */
  key: string;
  /** 后端抽象：标注/版本/中断/pin 都走它（deck 接原函数、html 接新内核）。 */
  target: SubmissionTarget;
  annotationIds: string[];
  /** 提交时防护性 commit 出的版本 = 对比/取消的"改前" */
  beforeVersionId: string;
  /** 收尾时 commit 出的版本；有值=「完成」，无值=「修改中」 */
  afterVersionId?: string;
  conversationId: string;
  /**
   * 单调递增的创建序号——焦点提交组解析（resolveFocusDeckPath）据此取"最近创建的活跃组"。
   * 不靠 Map 迭代顺序：同一 target 完成后再次提交时 Map.set 更新值却不移动 key 位置，
   * 迭代顺序会失真（任务 9 review 揪出）。序号在 createSubmission 唯一创建点单调发放。
   */
  createdSeq: number;
  /**
   * AI 收尾工具被回喂客观体检的次数（任务 9 决策 2）。两用：
   * ① 撞 MAX_FINALIZE_ROUNDS 触发安全阀强制定版；② >0 才认 acknowledge_residual
   * （守"先看过清单再 ack"）。纯内存、随组生命周期，组 remove 即消失。
   */
  finalizeAttempts?: number;
  /** 安全阀强制定版时的残留客观项条数（任务 9 决策 5 的 Q2 信号）；正常定版不设。 */
  residualOnForceFinalize?: number;
};

import type { Annotation } from '@shared/types';
import type { ArtifactSubmissionView } from '@shared/protocol';
import { newGroupId } from '@shared/ids';
import { readAnnotationsAt, updateAnnotationAt, removeAnnotationAt, readCropBytesAt } from './annotations';
import { resolveDeckPath } from './store';
import {
  recordInterruptionAt,
  clearInterruptionAt,
  listInterruptionsAt,
  getInterruptionAt,
  pruneInterruptionsAt,
} from './interruptionStore';

/** Map<target.key, Submission>——每 target 同时至多一个 */
const byKey = new Map<string, Submission>();

/** 单调递增的提交组创建序号（焦点解析用，不靠 Map 迭代顺序）。 */
let submissionSeq = 0;

/**
 * 建一个新 Submission（无 afterVersionId = 修改中）。
 * 若该 target 已有**未完成**的 Submission → 抛 ARTIFACT_SUBMISSION_IN_PROGRESS，
 * caller（router）据此返回 error，前端禁用提交（设计 §6.4 并发约束）。
 */
export function createSubmission(args: {
  groupId: string;
  target: SubmissionTarget;
  annotationIds: string[];
  beforeVersionId: string;
  conversationId: string;
}): Submission {
  const existing = byKey.get(args.target.key);
  if (existing && existing.afterVersionId === undefined) {
    const err = new Error(
      `target ${args.target.key} 已有未完成的提交组 ${existing.groupId}`,
    ) as Error & { code?: string };
    err.code = 'ARTIFACT_SUBMISSION_IN_PROGRESS';
    throw err;
  }
  const sub: Submission = {
    groupId: args.groupId,
    key: args.target.key,
    target: args.target,
    annotationIds: args.annotationIds,
    beforeVersionId: args.beforeVersionId,
    conversationId: args.conversationId,
    createdSeq: (submissionSeq += 1),
  };
  byKey.set(args.target.key, sub);
  return sub;
}

export function getByGroup(groupId: string): Submission | undefined {
  for (const sub of byKey.values()) {
    if (sub.groupId === groupId) return sub;
  }
  return undefined;
}

/** 按 target key（deck:artifactId / html:htmlPath）取活跃组。 */
export function getByArtifact(key: string): Submission | undefined {
  return byKey.get(key);
}

/**
 * 该 target 当前活跃组的前端视图（去掉 conversationId）；无活跃组 → null。
 * 各状态转移 handler 与 AI 收尾链路据此广播 submissionChanged。
 */
export function getSubmissionView(key: string): ArtifactSubmissionView | null {
  const sub = byKey.get(key);
  if (!sub) return null;
  return {
    groupId: sub.groupId,
    annotationIds: sub.annotationIds,
    beforeVersionId: sub.beforeVersionId,
    afterVersionId: sub.afterVersionId,
    residualOnForceFinalize: sub.residualOnForceFinalize,
  };
}

/**
 * 收尾工具被回喂一次时计数 +1（任务 9 决策 2）。groupId 不存在则静默 no-op（幂等）。
 * 与 setForceResidual 同属"收尾工具的内存探针"——纯内存状态，不落盘。
 */
export function bumpFinalizeAttempts(groupId: string): void {
  const sub = getByGroup(groupId);
  if (sub) sub.finalizeAttempts = (sub.finalizeAttempts ?? 0) + 1;
}

/** 安全阀强制定版时记残留条数（任务 9 Q2 信号）。groupId 不存在则静默 no-op。 */
export function setForceResidual(groupId: string, residual: number): void {
  const sub = getByGroup(groupId);
  if (sub) sub.residualOnForceFinalize = residual;
}

export function getByConversation(conversationId: string): Submission[] {
  return [...byKey.values()].filter((s) => s.conversationId === conversationId);
}

/**
 * 当前会话"焦点提交组"的 deck 路径（任务 9 决策 3）——主对话眼睛（view_slide /
 * render_contact_sheet）据此锚定看哪份 deck。焦点 = 本会话**最近创建的活跃（未完成）**提交组
 * （用户"改完 A 又改 B"时眼睛自然跟到 B）；无活跃组 → undefined（工具调用时优雅 isError）。
 * runner 进对话循环前解析一次注入 toolContext。html 提交组无 deck 路径（resolveDeckPath 抛 → undefined）。
 */
export async function resolveFocusDeckPath(conversationId: string): Promise<string | undefined> {
  const activeSub = getByConversation(conversationId)
    .filter((s) => s.afterVersionId === undefined)
    .sort((a, b) => b.createdSeq - a.createdSeq)[0]; // 最近创建的活跃组（不靠 Map 迭代顺序）
  if (!activeSub) return undefined;
  return resolveDeckPath(activeSub.key).catch(() => undefined);
}

/** 收尾：填 afterVersionId（组转「完成」）。groupId 不存在则 no-op 返回 undefined */
export function setAfterVersion(groupId: string, afterVersionId: string): Submission | undefined {
  const sub = getByGroup(groupId);
  if (!sub) return undefined;
  sub.afterVersionId = afterVersionId;
  return sub;
}

/** 删除 Submission（停止修改 / 保存 / 取消时释放并发约束）。找不到静默（幂等） */
export function remove(groupId: string): void {
  for (const [key, sub] of byKey.entries()) {
    if (sub.groupId === groupId) {
      byKey.delete(key);
      return;
    }
  }
}

/** 仅测试用：清空所有内存态 */
export function __resetForTest(): void {
  byKey.clear();
}

// ─── 提交 / 收尾 / 停止 的生命周期编排 ───────────────────────────────
// 这三个动作是 Submission 的状态转移，跟内存模型同属一层；router handler
// 和 AI 收尾工具都薄薄包一层调它们（系统性：同一逻辑一处实现）。

/** submitAnnotations 返回的注入 payload——前端据此预填对话 composer（设计 §6.2） */
export type SubmitPayloadItem = {
  annotationId: string;
  comment: string;
  /** crop 截图相对路径，无截图时空串 */
  cropPath: string;
  /** crop 截图字节（纯 base64，不带 `data:` 前缀）。无截图/读不到时省略 */
  cropBase64?: string;
};

export type SubmitResult = {
  groupId: string;
  beforeVersionId: string;
  payload: SubmitPayloadItem[];
};

/**
 * 提交一批标注（设计 §6.2，core 吃 target；deck/html 共用）：
 * 1. target.deriveBefore() 得 beforeVersionId（deck：dirty 则防护性 commit，否则 currentVersion；html：一律 commit）。
 * 2. 建 Submission（无 afterVersionId = 修改中）——并发约束在此守住。
 * 3. 落中断记录 + pin before（被引用版本免于 GC，裁定 A；deck pin 是 no-op）。
 * 4. 选中标注 status='submitted' + 打 groupId。
 * 5. 返回 { groupId, beforeVersionId, payload }。
 *
 * 并发约束（§6.4）：该 target 已有未完成 Submission 时 createSubmission 抛 ARTIFACT_SUBMISSION_IN_PROGRESS——
 * 在打标前先建组，保证拒绝时不留脏 status。
 */
export async function submitAnnotationsTo(
  target: SubmissionTarget,
  annotationIds: string[],
  conversationId: string,
): Promise<SubmitResult> {
  // 1. 改前 id
  const beforeVersionId = await target.deriveBefore();

  const groupId = newGroupId();

  // 2. 先建 Submission——并发约束在此守住；已有未完成组直接抛，不污染标注 status
  createSubmission({ groupId, target, annotationIds, beforeVersionId, conversationId });

  // 3. 落中断轻量持久记录（崩溃后据此认出「已中断」+「继续」/「退回改前」，PRD §六-6）+ pin before
  await recordInterruptionAt(target.interruptionsPath, { groupId, conversationId, beforeVersionId });
  await target.pin([beforeVersionId]);

  // 4. 选中标注 status='submitted' + 打 groupId（不传 comment → 不触发 pending 重置）
  for (const id of annotationIds) {
    await updateAnnotationAt(target.annotationLoc, id, { status: 'submitted', groupId });
  }

  // 5. payload：每条 comment + cropPath + crop 字节（供前端注入对话）。
  //    crop 字节由后端读盘转 base64——renderer 在 Vite dev 下拿不到 file://。
  const annotations = await readAnnotationsAt(target.annotationLoc);
  const payload: SubmitPayloadItem[] = await Promise.all(
    annotationIds.map(async (id) => {
      const a = annotations.find((x) => x.id === id);
      const item: SubmitPayloadItem = {
        annotationId: id,
        comment: a?.comment ?? '',
        cropPath: a?.cropPath ?? '',
      };
      if (a?.cropPath) {
        const bytes = await readCropBytesAt(target.annotationLoc, id);
        if (bytes) item.cropBase64 = Buffer.from(bytes).toString('base64');
      }
      return item;
    }),
  );

  return { groupId, beforeVersionId, payload };
}

/** deck-facing 适配器：artifactId → deckTarget（签名/行为不变）。 */
export async function submitAnnotations(args: {
  artifactId: string;
  annotationIds: string[];
  conversationId: string;
}): Promise<SubmitResult> {
  return submitAnnotationsTo(await deckTarget(args.artifactId), args.annotationIds, args.conversationId);
}

/** finalize 应用的逐条结果 */
export type FinalizeResults = Record<string, { ok: boolean; reason?: string }>;

export type FinalizeResult = {
  /** groupId 已解散（停止修改）或不存在 → no-op */
  noop: boolean;
  /** 提交目标键（deck:artifactId / html:resolve(htmlPath)）——caller 据此广播/解析 deckPath */
  key?: string;
  afterVersionId?: string;
};

/**
 * AI 显式收尾 / 用户手动完成（设计 §6.3）：
 * 1. 按 groupId 找 Submission；找不到（已被停止修改解散）→ no-op，不抛。
 * 2. target.pointer.commit('ai', summary) → afterVersionId；pin after；setAfterVersion。
 * 3. 应用 results：ok→清除该标注；failed→status='failed'+reason 留组内；未提及→默认成功清除。
 *
 * results 空（手动完成）= 全成功清除。
 *
 * summaryOverride（决策 D-D）：据文稿更新流本组无标注时 caller 传入摘要，避免架空版本历史/对比卡。
 */
export async function finalizeSubmission(
  groupId: string,
  results: FinalizeResults = {},
  summaryOverride?: string,
): Promise<FinalizeResult> {
  const sub = getByGroup(groupId);
  if (!sub) return { noop: true };
  // 幂等守卫（M1）：已完成组（afterVersionId 已有）再 finalize 直接 noop——否则连续收尾会留两个
  // ai 版本（与 stopSubmission 的"已完成不可停"对称）。
  if (sub.afterVersionId !== undefined) {
    return { noop: true, key: sub.key, afterVersionId: sub.afterVersionId };
  }
  const { target, annotationIds } = sub;

  // 收尾 summary：caller 传则用，否则本组 comment 拼接派生（在此拼好再传——pointer 只落盘）
  const annotations = await readAnnotationsAt(target.annotationLoc);
  const comments = annotationIds
    .map((id) => annotations.find((a) => a.id === id)?.comment)
    .filter((c): c is string => !!c);
  const after = await target.pointer.commit('ai', summaryOverride ?? deriveSummary(comments));
  await target.pin([after.versionId]); // 改后也 pin 至组解散（对比/取消引用，裁定 A；deck no-op）

  // 应用 results：未提及默认成功
  for (const id of annotationIds) {
    const r = results[id];
    if (r && r.ok === false) {
      await updateAnnotationAt(target.annotationLoc, id, {
        status: 'failed',
        failureMessage: r.reason ?? '未说明原因',
      });
    } else {
      // ok 或未提及 → 成功，清除该标注（连带删 crop）
      await removeAnnotationAt(target.annotationLoc, id);
    }
  }

  // setAfterVersion 放在标注处理之后：若上面某步 IO 抛错，组保持「修改中」（内存与前端一致），
  // 不会出现"内存已完成、前端还卡修改中"的错位——工具 catch 返回 isError，用户可重试/停止。
  setAfterVersion(groupId, after.versionId);

  // AI 收尾完成——这批标注已不在 submitted（成功删/失败转 failed），不再是「已中断」候选，清记录
  await clearInterruptionAt(target.interruptionsPath, groupId);

  return { noop: false, key: sub.key, afterVersionId: after.versionId };
}

/**
 * 停止修改（撤回，设计 §6.5）：仅「修改中」可停。
 * 该组标注 status 改回 'pending' + 清 groupId（走锁）；删 Submission（释放并发约束）；unpin before。
 * 之后对该 groupId 调 finalize → no-op（getByGroup 找不到）。
 *
 * 找不到 / 已完成 → no-op 返回 false（不回退文件、不中止对话）。
 */
export async function stopSubmission(groupId: string): Promise<{ ok: boolean; key?: string }> {
  const sub = getByGroup(groupId);
  if (!sub || sub.afterVersionId !== undefined) return { ok: false };
  const { target, annotationIds } = sub;
  for (const id of annotationIds) {
    // 改回 pending + 清 groupId（脱离已解散的组）
    await updateAnnotationAt(target.annotationLoc, id, { status: 'pending', groupId: undefined });
  }
  remove(groupId);
  await clearInterruptionAt(target.interruptionsPath, groupId);
  await target.unpin([sub.beforeVersionId]); // 修改中停止：仅 before 被 pin 过
  return { ok: true, key: sub.key };
}

/**
 * 保存（接受改后态，设计 §6.x）：仅「完成」组可保存。
 * 活动文件不动——保存即接受当前已 commit 的改后态。组内剩余标注（成功项已在 finalize 删除，剩的是
 * failed）清 groupId、保留 status='failed'，脱离组成为独立 failed 卡（用户改注释后可重提）；**绝不删除**。
 * remove(groupId) 释放并发约束；unpin before/after（之后回归常规 GC）。
 */
export async function saveSubmission(groupId: string): Promise<{ ok: boolean; key?: string }> {
  const sub = getByGroup(groupId);
  if (!sub) return { ok: false };
  await detachRemaining(sub);
  remove(groupId);
  await clearInterruptionAt(sub.target.interruptionsPath, groupId);
  await unpinGroup(sub);
  return { ok: true, key: sub.key };
}

/**
 * 取消（回退到改前态，设计 §6.x）：仿 save，区别只在额外 checkout 回退活动文件。
 * pointer.checkout(beforeVersionId)——回退到改前是安全网（deck force 不被缺图检查拦）；
 * 它会写回活动文件 + clearUndoStack。剩余 failed 标注同 save：清 groupId、保留 status。
 */
export async function cancelSubmission(groupId: string): Promise<{ ok: boolean; key?: string }> {
  const sub = getByGroup(groupId);
  if (!sub) return { ok: false };
  await sub.target.pointer.checkout(sub.beforeVersionId);
  await detachRemaining(sub);
  remove(groupId);
  await clearInterruptionAt(sub.target.interruptionsPath, groupId);
  await unpinGroup(sub);
  return { ok: true, key: sub.key };
}

/** 解散组时 unpin before（+ after 若已完成）——之后这些版本回归常规 GC。deck pin 是 no-op。 */
async function unpinGroup(sub: Submission): Promise<void> {
  const ids = [sub.beforeVersionId];
  if (sub.afterVersionId !== undefined) ids.push(sub.afterVersionId);
  await sub.target.unpin(ids);
}

/**
 * 解散组：组内**仍存在**的标注（成功项已在 finalize 删除，剩的是 failed）清 groupId、
 * 保留 status——脱离组成为独立 failed 卡（保留注释，用户改后可重提）。
 */
async function detachRemaining(sub: Submission): Promise<void> {
  const { target, annotationIds } = sub;
  const annotations = await readAnnotationsAt(target.annotationLoc);
  const alive = new Set(annotations.map((a) => a.id));
  for (const id of annotationIds) {
    if (alive.has(id)) await updateAnnotationAt(target.annotationLoc, id, { groupId: undefined });
  }
}

/**
 * 崩溃 / 退出兜底（设计 §6.6，core 吃 target）：Submission 只活内存，进程重启即丢，但磁盘上的
 * `submitted` 标注会带着失效 groupId 卡住。加载时做一次 reconcile：
 *  - `submitted` 但无 live Submission 且**有中断记录** → 保留为「已中断」（PRD §六-6），不降级
 *  - `submitted` 但无 live Submission 且无中断记录（孤儿）→ 降回 pending + 清 groupId
 *  - `failed` → 清 groupId（脱离失效组；status 留 failed）
 *
 * 重启后内存 Map 为空 → 所有无中断记录的 submitted 都算孤儿全降级，正确。返回是否有改动。
 * pin 不在此动：已中断组的 before 仍被引用（"退回改前"靠它），留 pin；失效记录被 prune 时其 before
 * 由 prune 的 unpin 回收（避免泄漏）。
 */
export async function reconcileOrphanedFor(target: SubmissionTarget): Promise<boolean> {
  const annotations = await readAnnotationsAt(target.annotationLoc);
  // 有中断记录的 groupId——这些孤儿 submitted 保留为「已中断」（PRD §六-6），不降级
  const records = await listInterruptionsAt(target.interruptionsPath);
  const interruptedGroups = new Set(records.map((r) => r.groupId));
  // reconcile **后**仍 submitted 的组（live 或已中断保留）——prune 据此清失效记录。不能用入口快照
  // 算（被本轮降级的标注在快照里仍 submitted，会被误判存活、记录漏清，reviewer Major#1）。
  const keptGroups = new Set<string>();
  let changed = false;
  for (const a of annotations) {
    if (a.status === 'submitted') {
      const live = a.groupId ? getByGroup(a.groupId) : undefined;
      if (!live && !(a.groupId && interruptedGroups.has(a.groupId))) {
        await updateAnnotationAt(target.annotationLoc, a.id, { status: 'pending', groupId: undefined });
        changed = true;
      } else if (a.groupId) {
        keptGroups.add(a.groupId); // 仍 submitted（live 修改中 或 已中断保留）
      }
    } else if (a.status === 'failed' && a.groupId !== undefined) {
      await updateAnnotationAt(target.annotationLoc, a.id, { groupId: undefined });
      changed = true;
    }
  }
  // 清失效中断记录 + unpin 其 before（避免被引用版本永久 pin 泄漏；deck unpin 是 no-op）
  const dropped = records.filter((r) => !keptGroups.has(r.groupId));
  await pruneInterruptionsAt(target.interruptionsPath, keptGroups);
  if (dropped.length > 0) await target.unpin(dropped.map((r) => r.beforeVersionId));
  return changed;
}

/**
 * 「已中断」组的前端视图（PRD §六-6，core 吃 target）：崩溃后无 live Submission，但有中断记录 +
 * 标注仍 submitted。重建 interrupted 视图供前端渲染「已中断」+「继续」/「退回改前」。无则 null。
 */
export async function getInterruptedViewFor(target: SubmissionTarget): Promise<ArtifactSubmissionView | null> {
  const records = await listInterruptionsAt(target.interruptionsPath);
  if (records.length === 0) return null;
  const annotations = await readAnnotationsAt(target.annotationLoc);
  // 倒序——多条残留记录（跨多次崩溃）时取**最新插入**那条，conversationId/beforeVersionId 才是最近一次
  for (const rec of [...records].reverse()) {
    if (getByGroup(rec.groupId)) continue; // 有 live 组 → 非中断
    const items = annotations.filter((a) => a.groupId === rec.groupId && a.status === 'submitted');
    if (items.length === 0) continue; // 标注已不在该组 submitted（失效记录）
    return {
      groupId: rec.groupId,
      annotationIds: items.map((a) => a.id),
      beforeVersionId: rec.beforeVersionId,
      conversationId: rec.conversationId,
      interrupted: true,
    };
  }
  return null;
}

/**
 * 「退回改前」（PRD §六-6，core 吃 target）：崩溃中断组无 live Submission，据中断记录 checkout 回
 * beforeVersionId、把该组标注降回 pending、清记录、unpin before。记录不存在 → no-op 返回 false。
 */
export async function discardInterruptedFor(target: SubmissionTarget, groupId: string): Promise<boolean> {
  const rec = await getInterruptionAt(target.interruptionsPath, groupId);
  if (!rec) return false;
  await target.pointer.checkout(rec.beforeVersionId);
  const annotations = await readAnnotationsAt(target.annotationLoc);
  for (const a of annotations) {
    if (a.groupId === groupId && a.status === 'submitted') {
      await updateAnnotationAt(target.annotationLoc, a.id, { status: 'pending', groupId: undefined });
    }
  }
  await clearInterruptionAt(target.interruptionsPath, groupId);
  await target.unpin([rec.beforeVersionId]);
  return true;
}

// ── deck-facing 适配器（artifactId → deckTarget，旧签名/行为不变）──────────────

export async function reconcileOrphanedSubmissions(artifactId: string): Promise<boolean> {
  return reconcileOrphanedFor(await deckTarget(artifactId));
}
export async function getInterruptedView(artifactId: string): Promise<ArtifactSubmissionView | null> {
  return getInterruptedViewFor(await deckTarget(artifactId));
}
export async function discardInterruptedGroup(artifactId: string, groupId: string): Promise<boolean> {
  return discardInterruptedFor(await deckTarget(artifactId), groupId);
}

function deriveSummary(comments: string[]): string {
  if (comments.length === 0) return 'AI 按标注修改';
  const joined = comments.join('；');
  return joined.length > 80 ? `${joined.slice(0, 80)}…` : joined;
}
