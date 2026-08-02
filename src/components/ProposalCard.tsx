/**
 * 提案卡片 dispatcher：按 kind 分发到具体子组件。
 * - kind === 'code'：CodeProposalCard（含 git guard / 派工按钮）
 * - kind === 'mcp.*'：McpProposalCard
 * - kind === 'plugin.*' / 'skill.*'：SkillModuleProposalCard（Skill 模块 v1）
 *
 * 拆分原因：原单文件早返回在所有 hooks 之前，触发 React Hooks 顺序违反；
 *   按 kind 分模块后各分支天然不持有对方需要的 stores。
 */
import { useTranslation } from 'react-i18next';
import type { ActionProposal } from '@shared/types';
import { CodeProposalCard } from './CodeProposalCard';
import { McpProposalCard } from './proposalCards/McpProposalCard';
import { SkillModuleProposalCard } from './proposalCards/SkillModuleProposalCard';
import { DeckCreateProposalCard } from './proposalCards/DeckCreateProposalCard';
import { FileWriteProposalCard } from './proposalCards/FileWriteProposalCard';
import { BashProposalCard } from './proposalCards/BashProposalCard';
import { WebAccessProposalCard } from './proposalCards/WebAccessProposalCard';
import { ScheduledTaskProposalCard } from './proposalCards/ScheduledTaskProposalCard';

type Props = {
  proposal: ActionProposal;
  onDiscussFurther?: () => void;
};

/**
 * 触发来源标注（S18/subagent）：审批卡若由定时任务执行体或对话期 subagent 触发，卡顶挂一行溯源，
 * 让用户知道「这张卡不是我这轮亲手让 Oru 做的，是那个后台任务撞到要审批」。放 dispatcher 层统一挂，
 * 各 kind 子卡零改动。
 */
function ProposalSourceBadge({ proposal }: { proposal: ActionProposal }) {
  const { t } = useTranslation('proposal');
  const label = proposal.triggeredByScheduledTask
    ? t('source.fromScheduledTask', { title: proposal.triggeredByScheduledTask.title })
    : proposal.triggeredBySubagent
      ? t('source.fromSubagent', { desc: proposal.triggeredBySubagent.description })
      : null;
  if (!label) return null;
  return <div className="mb-1 text-xs text-text-tertiary">{label}</div>;
}

export function ProposalCard({ proposal, onDiscussFurther }: Props) {
  const card = dispatchProposalCard(proposal, onDiscussFurther);
  if (!card) return null;
  return (
    <>
      <ProposalSourceBadge proposal={proposal} />
      {card}
    </>
  );
}

function dispatchProposalCard(proposal: ActionProposal, onDiscussFurther?: () => void) {
  if (proposal.kind === 'code') {
    return <CodeProposalCard proposal={proposal} onDiscussFurther={onDiscussFurther} />;
  }
  if (
    proposal.kind === 'plugin.install' ||
    proposal.kind === 'plugin.update' ||
    proposal.kind === 'plugin.uninstall' ||
    proposal.kind === 'skill.create' ||
    proposal.kind === 'skill.patch' ||
    proposal.kind === 'skill.install'
  ) {
    return <SkillModuleProposalCard proposal={proposal} />;
  }
  if (proposal.kind === 'deck.create') {
    return <DeckCreateProposalCard proposal={proposal} />;
  }
  if (proposal.kind === 'file.write') {
    return <FileWriteProposalCard proposal={proposal} />;
  }
  if (proposal.kind === 'bash') {
    return <BashProposalCard proposal={proposal} />;
  }
  if (proposal.kind === 'web.fetch' || proposal.kind === 'browser.navigate') {
    return <WebAccessProposalCard proposal={proposal} />;
  }
  if (proposal.kind === 'scheduled-task') {
    return <ScheduledTaskProposalCard proposal={proposal} />;
  }
  if (
    proposal.kind === 'mcp.install' ||
    proposal.kind === 'mcp.update' ||
    proposal.kind === 'mcp.delete'
  ) {
    return <McpProposalCard proposal={proposal} />;
  }
  // file.write / bash 卡在阶段 6 接入；未知 kind 不渲染（不静默误用 MCP 卡）
  return null;
}
