/**
 * 审批决定的先到先得同步原子门（S24）——settleApprovalDecision 的认领集，抽成零依赖叶子模块，
 * 好让 settleApprovalDecision 与 proposals/registry 都能 import 它而互不成环（注册表的提案离场处要调 forget 清理）。
 *
 * 单线程下 claimDecision 是原子的：第一个认领者拿到 true、独占该提案的决定，其余得 false。
 * 提案离场（discard / LRU 淘汰）时经 forgetDecisionClaim 清，防随内存 Map 增长而泄漏。
 */
const settledDecisions = new Set<string>();

/** 认领一个提案的决定；已被认领返回 false（先到者已赢）。 */
export function claimDecision(proposalId: string): boolean {
  if (settledDecisions.has(proposalId)) return false;
  settledDecisions.add(proposalId);
  return true;
}

export function forgetDecisionClaim(proposalId: string): void {
  settledDecisions.delete(proposalId);
}
