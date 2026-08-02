/**
 * 构造 MCP 系列 ActionProposal 的辅助（v0.6）。
 *
 * 由 mcp_install / mcp_update / mcp_delete agent tool 调用。
 *
 * 三者都置 `forceApproval: true`——「这类操作在工作挡要不要问人」的判定收敛在提案字段这一处
 * （原先散在 autoExecuteDecision 的 kind 常量里，与 proposeOrExecute 只认 forceApproval 的口径打架）。
 * 2026-07-30 决策 7：挂整类 `{category:'mcp'}` 授权——默认仍问，用户点「始终允许」后同类免卡。
 */
import type {
  McpDeleteProposal,
  McpInstallProposal,
  McpServerConfig,
  McpServerCreateInput,
  McpUpdateProposal,
} from '@shared/types';
import { newProposalId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';

export function buildInstallProposal(args: {
  conversationId: string;
  title: string;
  description: string;
  config: McpServerCreateInput;
}): McpInstallProposal {
  return {
    kind: 'mcp.install',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    forceApproval: true,
    grantable: [{ kind: 'category', id: 'mcp' }],
    config: args.config,
  };
}

export function buildUpdateProposal(args: {
  conversationId: string;
  title: string;
  description: string;
  serverId: string;
  patch: McpUpdateProposal['patch'];
  before: McpServerConfig;
}): McpUpdateProposal {
  return {
    kind: 'mcp.update',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    forceApproval: true,
    grantable: [{ kind: 'category', id: 'mcp' }],
    serverId: args.serverId,
    patch: args.patch,
    before: args.before,
  };
}

export function buildDeleteProposal(args: {
  conversationId: string;
  title: string;
  description: string;
  serverId: string;
  target: McpDeleteProposal['target'];
}): McpDeleteProposal {
  return {
    kind: 'mcp.delete',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    forceApproval: true,
    grantable: [{ kind: 'category', id: 'mcp' }],
    serverId: args.serverId,
    target: args.target,
  };
}
