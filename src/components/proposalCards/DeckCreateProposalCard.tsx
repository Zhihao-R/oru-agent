/**
 * Deck 创建提案卡（v1 阶段 4 端到端可用版）
 *
 * 阶段 7 会换成 reader-01 demo 完整样式（结构化字段 dl + 位置 / Skill / 规模 / 预计）。
 * 当前版本：基本信息 + "开始生成" / "取消" 按钮，让端到端流程跑通。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Presentation } from 'lucide-react';
import type { DeckCreateProposal } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { useTaskStore } from '@/stores/taskStore';
import { Button } from '../ui/Button';
import { ProposalTerminalLine } from './ProposalTerminalLine';

export function DeckCreateProposalCard({ proposal }: { proposal: DeckCreateProposal }) {
  const { t } = useTranslation('proposal');
  const [submitting, setSubmitting] = useState(false);
  const removeProposal = useTaskStore((s) => s.removeProposal);

  const isPending = proposal.status === 'pending';
  // 非空 grantable → 该提案可「始终允许」（灾难级 / 不可持久授权时 undefined）
  const canAlways = (proposal.grantable?.length ?? 0) > 0;

  const onApprove = async (always: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await wsClient.request({ type: 'proposal.execute', proposalId: proposal.id, always });
      // status 会通过 proposal.statusChanged broadcast 更新；这里不本地改
    } catch {
      setSubmitting(false);
    }
  };

  const onDiscard = async () => {
    try {
      await wsClient.request({ type: 'proposal.discard', proposalId: proposal.id });
    } catch {
      // 失败不动本地 store——卡留着，后端工具 waiter 仍可能被兑现；失败也移除会让卡没了、
      // 后端回合永挂「正在调用」。
      return;
    }
    removeProposal(proposal.id);
  };

  return (
    <div className="rounded-sm border border-border-strong bg-elevated px-4 py-3 shadow-soft">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Presentation size={12} strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">{proposal.title}</div>
          <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
            {proposal.description}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs uppercase tracking-wider text-text-tertiary">
            <span>deck.create</span>
            <span>·</span>
            <span>{proposal.sizeHint}</span>
            {proposal.etaHint ? (
              <>
                <span>·</span>
                <span>{proposal.etaHint}</span>
              </>
            ) : null}
            <span>·</span>
            <span className="font-mono normal-case">{proposal.deckSkillId}</span>
          </div>
        </div>
      </div>

      {!isPending ? (
        // 非 pending：只留一行终态存证（G31）
        <ProposalTerminalLine proposal={proposal} />
      ) : (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => void onDiscard()} disabled={submitting}>
            {t('nevermind')}
          </Button>
          {canAlways ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onApprove(true)}
              disabled={submitting || !isPending}
            >
              {t('remote.always')}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void onApprove(false)}
            disabled={submitting || !isPending}
          >
            {submitting ? t('dispatching') : t('deck.startGenerate')}
          </Button>
        </div>
      )}
    </div>
  );
}
