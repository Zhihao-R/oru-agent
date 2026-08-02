/**
 * 提案校验 + 映射逻辑：Task(mode=async) 派工（dispatchAsyncSubagent）与 propose_* 族共用的纯逻辑层。
 *
 * 原本还含三个 SDK-MCP server 工厂（createTwinMainMcp 等），SDK-MCP → agentTools 迁移后已无人调用，
 * 已删除。这里只保留 propose 的校验与 ActionProposal 映射，便于在 smoke 里直接验证 emit 的对象 shape。
 */
import type { ActionProposal, CodeActionProposal, ProposalRisk } from '@shared/types';
import { newProposalId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { getProject, isGitRepo } from '../projects/store';

export type ProposalEmit = (proposal: ActionProposal) => Promise<void>;
export type EscalateHandler = (taskId: string, question: string) => Promise<void>;

/**
 * 派工（Task async / propose_* 族）的 target_project_id 验证逻辑（独立出来便于测）
 *
 * 守卫从「拦截」改为「提示」后，这里只回答「目标是不是 git 仓」这一个事实——
 * 是否提示（每项目每天一次）由 maybeShowGitHint 在触发点独立判定，与此解耦。
 *
 * 规则：
 * - null → ok + isGit:true（家目录任务，不强制 rollbackable）
 * - 不存在的 id → 硬拒（Twin 用错 id）
 * - 项目是 git 仓 → ok + isGit:true
 * - 项目非 git → ok + isGit:false（rollbackable 将被强制 false）
 */
export type ProposeValidation =
  | { ok: true; isGit: boolean }
  | { ok: false; reason: string };

export async function validateProposeTarget(targetProjectId: string | null): Promise<ProposeValidation> {
  if (!targetProjectId) return { ok: true, isGit: true };
  let p;
  try {
    p = await getProject(targetProjectId);
  } catch (e) {
    return {
      ok: false,
      reason: `找不到项目 id=${targetProjectId}。请先用 list_projects 查可用项目，或确认 id 拼写。错误: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { ok: true, isGit: isGitRepo(p.path) };
}

/**
 * 派工（Task async / propose_* 族）的核心映射逻辑——把工具输入 + validate 结果映射为
 * ActionProposal + 给 Twin 看的工具结果文本。
 * 抽出独立函数便于在 smoke 里直接验证 emit 的对象 shape，不必触及 SDK MCP server 内部。
 */
export type ProposeBuildInput = {
  conversationId: string;
  title: string;
  description: string;
  targetProjectId: string | null;
  risk: ProposalRisk;
  rollbackable: boolean;
  rawPlan: string;
  profileId?: string;
};

export type ProposeBuildResult =
  | { ok: true; proposal: CodeActionProposal; toolText: string }
  | { ok: false; toolText: string };

export async function buildProposalFromInput(input: ProposeBuildInput): Promise<ProposeBuildResult> {
  const v = await validateProposeTarget(input.targetProjectId);
  if (!v.ok) {
    return { ok: false, toolText: `提案被拒绝：${v.reason}` };
  }
  // 非 git 项目强制 rollbackable=false，无论 Twin 自己怎么填（卡片底部据此标注「不可自动回滚」）
  const rollbackable = v.isGit ? input.rollbackable : false;
  const proposal: CodeActionProposal = {
    kind: 'code',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: input.conversationId,
    title: input.title,
    description: input.description,
    targetProjectId: input.targetProjectId,
    risk: input.risk,
    rollbackable,
    rawPlan: input.rawPlan,
    createdAt: Date.now(),
    profileId: input.profileId ?? 'project-coder',
  };
  // 中性回执，仅用于 onProposal 缺席的死角（正常对话恒有 onProposal，此时由 proposeAction 覆盖成
  // 「已派工」回执）。此处不预言路由结果——派工是否/如何执行由上层 onProposal + 自动执行判定决定。
  const toolText = `提案已构造（id=${proposal.id}, profile=${proposal.profileId}）。`;
  return { ok: true, proposal, toolText };
}
