/**
 * dispatchAsyncSubagent——「派后台 subagent 干活」的共享派发函数（委派工具收敛 v2026-08-02）。
 *
 * 原 propose_action 工具的 execute 逻辑抽到这里，Task 工具的 async 分支调用它。
 * 收敛后模型侧只剩一个 `Task` 工具，approval/risk/rollbackable/target_project_id/profile_id
 * 等 proposal 元数据不再暴露给模型，由本函数填默认值：
 *   - targetProjectId  = ctx.activeProjectId（当前 active 项目；null = 家目录任务）
 *   - risk             = 'medium'（默认档；模型不背审批负担）
 *   - rollbackable     = 由 buildProposalFromInput 内部按 git 状态自动算（非 git 强制 false）
 *   - profileId        = 'project-coder'（与 buildProposalFromInput 默认一致）
 *
 * subagentRunner 执行期深度耦合 ActionProposal 字段（rawPlan/targetProjectId/title/
 * conversationId/deckContext/profileId），走 proposal 即复用成熟的后台任务工作流，零重构。
 */
import type { AgentTool, ToolContext } from '@shared/agent/backend';
import type { ProposalRisk } from '@shared/types';
import { buildProposalFromInput } from '../oruMcpFactory';
import { subagentCoderReady } from '../backends';
import { getProject } from '../../projects/store';
import { maybeShowGitHint } from '../../projects/gitHint';

/** 系统默认填的审批风险档（模型不再填）。 */
const DEFAULT_RISK: ProposalRisk = 'medium';

export type DispatchAsyncSubagentArgs = {
  description: string;
  prompt: string;
};

/**
 * 派一个后台 subagent（async）去实际执行一段工作。
 * 派工本身立即生效、不需用户批准；subagent 执行时碰到改动环境的操作再按当前审批挡位逐个过闸。
 * 成功后返回「已派工」回执（含任务/提案 id），父回合不阻塞。
 */
export async function dispatchAsyncSubagent(
  ctx: ToolContext,
  args: DispatchAsyncSubagentArgs,
): Promise<ReturnType<AgentTool['execute']>> {
  // 派工前置自检：subagent coder 是否可用
  // （早失败 UX，避免用户批准后才在 runTask 执行阶段崩）
  const ready = await subagentCoderReady();
  if (!ready.ok) {
    return {
      isError: true,
      text:
        `无法派后台编码 subagent：${ready.hint ?? '请去设置确认该模型的鉴权配置'}。\n` +
        `若是小改动，你可以自己用 edit_file / write_file / bash 处理；` +
        `若确需派工，请去设置确认该模型的鉴权配置后重试。`,
    };
  }
  const r = await buildProposalFromInput({
    conversationId: ctx.conversationId,
    title: args.description,
    description: args.description,
    // task 不该暴露 target_project_id：派工默认当前 active 项目，null = 家目录任务。
    // 缺省填 ctx.activeProjectId——漏填成 null 会让 subagentRunner 跳过 git baseline/feature
    // branch/project cwd（subagentRunner.ts:252 if (proposal.targetProjectId)），活会干错目录。
    targetProjectId: ctx.activeProjectId ?? null,
    risk: DEFAULT_RISK,
    // rollbackable 填 true 占位：实际值由 buildProposalFromInput 内部按 git 状态判
    //（v.isGit ? input.rollbackable : false）——git 项目可回滚、非 git 强制 false 并弹 gitHint。
    // 填 false 会让 git 项目也变成不可回滚，违背「模型不填审批元数据、系统按 git 自动判」的收敛意图。
    rollbackable: true,
    rawPlan: args.prompt,
    profileId: 'project-coder',
  });
  if (!r.ok) {
    return { isError: true, text: r.toolText };
  }
  // 当天首次改这个非 git 项目时在对话流提示「难以一键回退」（每项目每天一次）。
  // 校验已过，targetProjectId 非 null 即有效；null（家目录任务）不提示。
  if (r.proposal.targetProjectId) {
    await maybeShowGitHint(ctx, await getProject(r.proposal.targetProjectId));
  }
  // 通过 ctx.onProposal 把 proposal 推给上层
  if (ctx.onProposal) {
    try {
      await ctx.onProposal(r.proposal);
    } catch (e) {
      return {
        isError: true,
        text: `提案构造成功但派发失败：${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // 派工（code）在任何审批挡位都自动执行（proposals/autoExecuteDecision.ts 的
    // shouldAutoExecuteProposal：kind==='code' 恒 true，且 code 提案 forceApproval 恒 false）——
    // onProposal 成功即已入队后台跑。故如实回执「已派工」，
    // 绝不给模型「等用户批准」的暗示：否则它会照着让用户去点根本不存在的批准按钮（危险档下真实发生过）。
    return {
      text:
        `已把这件事派给后台 subagent 执行（id=${r.proposal.id}, profile=${r.proposal.profileId}），正在跑；` +
        `完成后我拿到结果再汇报。派工不需用户批准，在收到结果前别宣告完成。`,
    };
  }
  return { text: r.toolText };
}
