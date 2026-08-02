/**
 * Code-kind 提案卡片：分身要改代码时在 ChatArea 流里出现
 *
 * 审批模式（默认）：[让他去做] [我有想法补充] [算了]
 * 非严格挡：不渲染按钮，标"已派工"
 *
 * 项目未启用 git 时不再拦截——按钮照常可点。底部如实标注「不可自动回滚」
 * （读 proposal.rollbackable === false）；项目级的一次性知会由对话流里的提示条负责。
 */
import { ShieldCheck, AlertTriangle, Flame, Send, X, MessageSquarePlus, Loader2, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import type { ActionProposal } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { useAgentStore } from '@/stores/agentStore';
import { useTaskStore } from '@/stores/taskStore';
import { ProposalTerminalLine } from './proposalCards/ProposalTerminalLine';
import { Button } from './ui/Button';

type CodeProposal = Extract<ActionProposal, { kind: 'code' }>;

type Props = {
  proposal: CodeProposal;
  onDiscussFurther?: () => void;
};

export function CodeProposalCard({ proposal, onDiscussFurther }: Props) {
  const { t } = useTranslation('proposal');
  // 只读挡：router 不自动派工（onProposal 闸 mode!=='readonly' 才 enqueue），卡片待批——
  // 由用户手动点「让他去做」派出（用户主动操作，只读不约束；派出的 subagent 自身仍继承只读受限）。
  // work / danger：已自动派工，无需手动按钮。
  const isReadonly = useAgentStore(
    (s) => (s.agents.find((a) => a.id === s.activeAgentId)?.approvalMode ?? 'work') === 'readonly',
  );
  const removeProposal = useTaskStore((s) => s.removeProposal);

  // 派工过渡态：点"让他去做"后，proposal 不立即从 store 删（由 task-report 路径兜底删），
  // 卡片上按钮变 disabled + 显示"派工中…"，避免用户重复点击 + 提供"agent 在工作"的反馈
  // 等 task.started 事件到达，TaskCard 检测到对应 task → 整个组件被切换成 RunningView
  // → 本组件 unmount → submitting state 自然消失。
  const [submitting, setSubmitting] = useState(false);
  // 已决静态（PM 定稿）：status 离开 pending（入队/起跑/已决）后按钮收走，换静态状态行——
  // 「派工中…」动效只盖住本次点击到 statusChanged 回推的窗口，不冒充终态。
  // status 盖住其余一切来源（重载、信任模式派工、statusChanged 广播），
  // 双击/拒绝叠加在后端还有幂等兜底，这里是第一道闸。
  const decided = proposal.status !== 'pending';

  const onApprove = () => {
    if (submitting || decided) return;
    setSubmitting(true);
    void wsClient
      .request({ type: 'proposal.execute', proposalId: proposal.id })
      .catch(() => {
        // 派工失败：恢复按钮，让用户能重试
        setSubmitting(false);
      });
    // 不在这里 removeProposal——交给 chat.taskReport 事件统一清理（App.tsx）
    // 这样 task.started 之前 TaskCard 仍能挂载，过渡到 RunningView 折叠卡
  };
  const onDiscard = () => {
    void wsClient
      .request({ type: 'proposal.discard', proposalId: proposal.id })
      .catch(() => undefined);
    removeProposal(proposal.id);
  };

  const RiskIcon = proposal.risk === 'high' ? Flame : proposal.risk === 'medium' ? AlertTriangle : ShieldCheck;
  const riskTone =
    proposal.risk === 'high'
      ? 'text-danger'
      : proposal.risk === 'medium'
        ? 'text-warn'
        : 'text-success';
  const riskLabel =
    proposal.risk === 'high' ? t('code.riskHigh') : proposal.risk === 'medium' ? t('code.riskMedium') : t('code.riskLow');

  return (
    <div className="rounded-sm border border-border-strong bg-elevated px-4 py-3 shadow-soft">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Wrench size={12} strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">{proposal.title}</div>
          <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
            {proposal.description}
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-3 text-xs text-text-tertiary">
        <span className={cn('inline-flex items-center gap-1', riskTone)}>
          <RiskIcon size={12} strokeWidth={1.5} />
          {riskLabel}
        </span>
        <span>·</span>
        {proposal.rollbackable === false ? (
          <span className="inline-flex items-center gap-1 text-danger">
            <AlertTriangle size={12} strokeWidth={1.5} />
            {t('code.noAutoRollback')}
          </span>
        ) : (
          <span>{t('code.canRollback')}</span>
        )}
        {proposal.profileId && proposal.profileId !== 'project-coder' ? (
          <>
            <span>·</span>
            <span>profile: {proposal.profileId}</span>
          </>
        ) : null}
      </div>

      {!isReadonly ? (
        <div className="mt-3 text-xs text-text-tertiary">{t('code.autoDispatched')}</div>
      ) : decided ? (
        // 非 pending：只留一行终态存证（G31）——过程与结果由 TaskCard / 聊天播报呈现，卡片不复述。
        <ProposalTerminalLine proposal={proposal} />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={onApprove}
            disabled={submitting}
            leftIcon={
              submitting ? (
                <Loader2 size={12} strokeWidth={1.5} className="animate-spin" />
              ) : (
                <Send size={12} strokeWidth={1.5} />
              )
            }
          >
            {submitting ? t('dispatching') : t('accept')}
          </Button>
          {onDiscussFurther ? (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={onDiscussFurther}
              disabled={submitting}
              leftIcon={<MessageSquarePlus size={12} strokeWidth={1.5} />}
            >
              {t('code.haveThoughts')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={onDiscard}
            disabled={submitting}
            leftIcon={<X size={12} strokeWidth={1.5} />}
          >
            {t('nevermind')}
          </Button>
        </div>
      )}
    </div>
  );
}
