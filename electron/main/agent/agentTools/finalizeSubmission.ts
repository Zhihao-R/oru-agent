/**
 * AI 显式收尾工具 `artifact_finalize_submission`（设计 §6.3；任务 9 加建议式体检回路）
 *
 * 完成靠 AI 显式调本工具（工具内部 commit + 打标），不靠 Oru 猜（绝不 isDirty 反推）。
 * AI 没调 → 组停在「修改中」、可手动完成、不卡死。
 *
 * 任务 9（标注修改自检）：execute 在调 core 定版**之前**先对改后的 deck 跑一次客观体检
 * （validateDeck），按"建议式"处置——
 *  - 无客观硬伤 → 直接定版（干净收工）。
 *  - 有硬伤、未 ack 或首次调用 → 回喂清单、**不定版**（finalizeAttempts++），逼 AI 看过再决定。
 *  - 有硬伤、AI 带 acknowledge_residual 且此前已回喂过（attempts>0）→ 定版，残留交 AI 自述。
 *  - 有硬伤、撞 MAX_FINALIZE_ROUNDS（打地鼠不收敛）→ 安全阀强制定版 + 记 Q2 信号。
 * 体检的 deckPath 用 group_id 显式解析、永不锚错（决策 3）。core finalizeSubmission 不变。
 * 用户手动「标记完成」走 router 直连 core、不过本工具，天然不跑体检（决策 1）。
 */
import type { AgentTool } from '@shared/agent/backend';
import {
  finalizeSubmission,
  getByGroup,
  stopSubmission,
  bumpFinalizeAttempts,
  setForceResidual,
  type FinalizeResults,
} from '../../deck/submissions';
import { resolveDeckPath } from '../../deck/store';
import { isDirty } from '../../deck/history';
import { flushPending } from '../../deck/commitScheduler';
import { validateDeck } from '../../deck/validateDeck';
import { buildRefeedText } from '../../deck/deckFixPrompts';

/** AI 改不收敛（打地鼠）时的收尾轮数硬上限（任务 9 决策 2，沿用生成路 MAX_FIX_ROUNDS=3 量级）。 */
const MAX_FINALIZE_ROUNDS = 3;

export function makeFinalizeSubmissionTool(): AgentTool {
  return {
    name: 'artifact_finalize_submission',
    mutatesEnvironment: true,
    description:
      '完成对某个制品（artifact）提交组的修改后，必须调用本工具收尾——它会落一个新版本并逐条标记成败。' +
      '入参 group_id 来自你收到的标注提交提示。' +
      'results 按 annotation id 逐条报告：做到了 { ok: true }；做不到（矛盾/缺资源/无法定位）{ ok: false, reason: "简短原因" }；' +
      '未在 results 里提及的标注默认视为成功。' +
      '收尾时系统会对改后的 deck 做一次客观体检（失效图 / 内容溢出 / 空白页 / 结构契约），' +
      '有硬伤会把清单发回给你、暂不定版；修掉后再次调用即可，或判断该保留时带 acknowledge_residual:true 再次调用定版（并在回复里向用户说明）。' +
      '据文稿更新（本组无标注）收尾时，**应**在 summary 里用 1-2 句概述这次据文稿改了什么的重点——版本历史/对比卡靠它让用户看清这次改动；标注修改收尾可不传（默认按标注内容派生摘要）。' +
      '若你声称改了但其实没动 index.html，本工具会撤销本次提交（不落空版本），不报错。' +
      '若 group_id 已失效（用户中途停止了修改）→ 本工具静默成功，不报错。',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '提交组 id（grp_ 前缀），来自标注提交提示' },
        summary: {
          type: 'string',
          description:
            '这次据文稿改了什么的重点，1-2 句——落进版本历史/对比卡。据文稿更新（无标注）收尾时应填；标注修改可省略（默认按标注内容派生）。',
        },
        results: {
          type: 'object',
          description:
            '按 annotation id 的逐条结果映射，如 {"ann_xxx": {"ok": true}, "ann_yyy": {"ok": false, "reason": "..."}}',
          additionalProperties: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              reason: { type: 'string' },
            },
            required: ['ok'],
          },
        },
        acknowledge_residual: {
          type: 'boolean',
          description:
            '看过收尾体检回喂的客观清单后，仍判断这些项该保留（用户要求无视 / 有意设计）时传 true，定版并放行残留。' +
            '首次调用（还没被回喂过清单）即便传 true 也不生效——会先把清单发回让你看过。',
        },
      },
      required: ['group_id'],
    },
    async execute(input, ctx) {
      const args = input as {
        group_id: string;
        summary?: string;
        results?: FinalizeResults;
        acknowledge_residual?: boolean;
      };
      const sub = getByGroup(args.group_id);
      if (!sub) {
        return { text: `提交组 ${args.group_id} 已不存在（可能被停止修改解散）——无需收尾。` };
      }
      // C-1 代码层护栏：本工具是 deck 专属（含 resolveDeckPath/validateDeck/flushPending，对 html 路径会抛）。
      // 非 deck 组（html）旁路体检、由用户手动「标记完成」收尾——这里直接优雅返回，不碰任何 deck 逻辑、不广播。
      if (sub.target.kind !== 'deck') {
        return {
          text: `提交组 ${args.group_id} 是网页（非 deck）标注，不走本工具——你按标注改完 HTML 源文件即可，用户会在预览里核对后点「标记完成」定版。`,
        };
      }

      try {
        // noop 短路（决策 D-E）：仅对**纯文稿更新组（无标注）**生效——index.html 相对当前版本没变
        // → AI 声称改了却没动 HTML，在贵的渲染体检（validateDeck）之前撤销本次提交、不落空版本。
        // 标注组（annotationIds 非空）**不走 noop**：HTML 没变可能是 AI 判定所有标注都做不到，
        // 那些失败原因要经 finalize 落进 failed 卡给用户看，绝不能连组一起静默抹掉。
        if (sub.annotationIds.length === 0) {
          await flushPending(sub.key);
          if (!(await isDirty(sub.key))) {
            await stopSubmission(args.group_id);
            await ctx.onArtifactSubmissionChanged?.(sub.key);
            return { text: '据文稿无需改动 index.html，已撤销本次更新（未落版本）。' };
          }
        }

        // 体检：用 group_id 显式解析 deckPath，永不锚错（决策 3）；透传 abort（决策 6/§7）。
        // stub（任务 7 未就位）恒返 [] → 一次即定版、行为同现状。
        const deckPath = await resolveDeckPath(sub.key);
        const errors = await validateDeck(deckPath, ctx.abortSignal);
        const attempts = sub.finalizeAttempts ?? 0;

        const commitClean = errors.length === 0;
        // ack 仅在已回喂过（attempts>0）时认——守"先看清单再 ack"的硬保证（首次 ack 不生效）。
        const commitAck =
          errors.length > 0 && args.acknowledge_residual === true && attempts > 0;
        // 安全阀：撞轮数上限（打地鼠不收敛）强制定版。
        const commitValve = errors.length > 0 && attempts >= MAX_FINALIZE_ROUNDS;

        if (!commitClean && !commitAck && !commitValve) {
          bumpFinalizeAttempts(args.group_id);
          return { text: buildRefeedText(errors) };
        }

        const r = await finalizeSubmission(args.group_id, args.results ?? {}, args.summary);
        if (r.noop) {
          // 罕见竞态：体检期间组被解散
          return { text: `提交组 ${args.group_id} 已不存在（可能被停止修改解散）——无需收尾。` };
        }
        // 仅安全阀强制定版这条路记 Q2 信号（决策 5）；ack 主动保留不记（AI 已被要求自述，更可靠）。
        // 定版成功后才写——保证"设值即广播"：若上面 finalize 抛错走 catch，组不会留下未广播的残留标记。
        if (commitValve && !commitAck) setForceResidual(args.group_id, errors.length);
        // 收尾成功（非 noop）→ 让上层广播组状态变化到前端（带 residualOnForceFinalize）
        await ctx.onArtifactSubmissionChanged?.(r.key!);
        const keepReminder =
          errors.length > 0
            ? `（仍有 ${errors.length} 处客观问题——请在给用户的回复里说明保留了什么、为什么）`
            : '';
        return {
          text: `已收尾提交组 ${args.group_id}：落版本 ${r.afterVersionId}。成功项已清除，失败项留在组内待用户处理。${keepReminder}`,
        };
      } catch (e) {
        if (ctx.abortSignal?.aborted) throw e; // 取消透传，不谎报（abort 纪律，对齐 viewSlide）
        return { isError: true, text: `收尾失败：${(e as Error).message}` };
      }
    },
  };
}
