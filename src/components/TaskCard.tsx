/**
 * 任务卡片：根据 task 状态分发渲染
 *
 * 状态 → 形态（委派工具收敛 §6.2）：
 * - 没 task（仅 proposal）→ pending 给提案审批卡；已决不渲染回执（2026-07-29 拍板，trace 留痕卡除外）
 * - task 在运行中（pending/running/awaiting_twin/awaiting_user）→ 不渲染，由底部 SubagentBar 聚合条承载
 *   （运行中折叠卡 RunningView 已退役，不再在消息流里铺独立运行卡）
 * - 终态（done/failed/cancelled/rolled_back/interrupted）由 task-report 消息渲染为 simple 完成行
 *   （AsyncTaskReportCard，2026-08-02 拍板），这里只留一个轻量占位避免空白
 */
import { useTranslation } from 'react-i18next';
import { useTaskStore } from '@/stores/taskStore';
import type { ActionProposal, SubagentTask } from '@shared/types';
import { useIsReadonly } from '@/lib/approvalMode';
import { ProposalCard } from './ProposalCard';

/** 异步子 agent 视为「运行中」的状态集——由 SubagentBar 承载，流内不渲染 */
const TASK_INFLIGHT: ReadonlySet<SubagentTask['status']> = new Set([
  'pending',
  'running',
  'awaiting_twin',
  'awaiting_user',
]);

type Props = {
  proposal: ActionProposal;
  onDiscussFurther?: () => void;
};

export function TaskCard({ proposal, onDiscussFurther }: Props) {
  const isReadonly = useIsReadonly();
  // 找跟该 proposal 关联的 task（如果已经派工）
  const tasks = useTaskStore((s) => s.tasks);
  const task = Object.values(tasks).find((t) => t.proposalId === proposal.id) ?? null;

  if (!task) {
    // work/danger：code 派工 auto 执行、排队态由 SubagentBar 的「排队中」行承载，流内不铺静态卡
    // （避免与排队行双呈现）。readonly：router 不自动派工，code 是真审批，留给 CodeProposalCard 走工具审批
    if (proposal.kind === 'code' && !isReadonly && proposal.status === 'pending') return null;
    // 已决提案的回执不在流内渲染（2026-07-29 拍板：工具继续执行本身就是反馈，审批留痕落盘审计）。
    // 例外：proposal.trace 留痕卡——全放挡自动执行没弹过审批卡，那行终态是用户唯一的现场（S24 · G31）。
    if (proposal.status !== 'pending' && !proposal.trace) return null;
    return <ProposalCard proposal={proposal} onDiscussFurther={onDiscussFurther} />;
  }
  // 运行中（pending/running/awaiting_twin/awaiting_user）由 SubagentBar 聚合条承载，
  // 消息流里不再铺独立运行卡（委派收敛 §6.2 RunningView 退役）。
  if (TASK_INFLIGHT.has(task.status)) return null;
  // 终态（done/failed/cancelled/rolled_back/interrupted）由 task-report 消息渲染为 simple 完成行
  // 这里渲染一个轻量"已结束"占位避免空白
  return <TerminalPlaceholder task={task} />;
}

// ─── 终态占位（task 已结束但 task-report 消息还没渲染时出现的瞬间） ───

function TerminalPlaceholder({ task }: { task: SubagentTask }) {
  const { t } = useTranslation('task');
  return (
    <div className="rounded-sm border border-border bg-elevated/40 px-4 py-2.5 text-xs text-text-tertiary">
      <span>{t('terminalPlaceholder', { title: task.proposalTitle, status: task.status })}</span>
    </div>
  );
}
