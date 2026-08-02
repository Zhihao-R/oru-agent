/**
 * 待决策停靠面板（2026-07-19 话-1）——把「Oru 停下来等你」的两类卡从消息滚动流沉到输入框正上方：
 * 提案审批卡（pending 态）与追问卡（ask_user_choice）。语义是「要处理的」和「处理的地方」合一。
 *
 * 只收 pending 提案（审批 UI）：一旦批准转为 executing/task，就变「进行中指示」留在消息流（RunningView），
 * 不进本面板。追问同理只收待答的。审批与追问互斥——审批优先，清空后追问才接管（设计：不同时占面板）。
 * 多条提案逐条翻页「◀ n/N ▶」，无批量批准（安全不变量）。卡内审批/提交逻辑完全复用原组件，本面板只管收拢与翻页。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ActionProposal } from '@shared/types';
import { useTaskStore } from '@/stores/taskStore';
import { useChatStore } from '@/stores/chatStore';
import { ProposalCard } from '../ProposalCard';
import { AskUserChoiceCard } from './AskUserChoiceCard';
import { PendingDot } from './PendingDot';

const EMPTY_PROPOSALS: ActionProposal[] = [];

export function PendingDecisionDock({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('chat');
  const proposals = useTaskStore((s) => s.proposalsByConv[conversationId] ?? EMPTY_PROPOSALS);
  // code 派工（异步 subagent）恒自动执行、从不走审批，只由底部 SubagentBar 排队/运行行承载——
  // 不进审批停靠面板（2026-08-02 方案改动点1）。
  const pendingProposals = proposals.filter((p) => p.status === 'pending' && p.kind !== 'code');
  const pendingAsksMap = useChatStore((s) => s.pendingAsks);
  const asks = Object.values(pendingAsksMap).filter((a) => a.conversationId === conversationId);

  const [rawIdx, setRawIdx] = useState(0);

  if (pendingProposals.length > 0) {
    // 处理完自动前移靠 clamp 实现：列表缩短后 idx 越界即落到下一条待审
    const idx = Math.min(rawIdx, pendingProposals.length - 1);
    const total = pendingProposals.length;
    const p = pendingProposals[idx];
    return (
      <Dock>
        {total > 1 ? (
          <div className="mb-1.5 flex items-center gap-2 text-xs text-warn-deep">
            <PendingDot />
            <span className="font-medium">{t('dock.pendingApproval')}</span>
            <span className="ml-auto flex items-center gap-1 text-text-tertiary">
              <button
                type="button"
                disabled={idx === 0}
                onClick={() => setRawIdx(idx - 1)}
                aria-label={t('dock.prev')}
                className="grid h-5 w-5 place-items-center rounded transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ChevronLeft size={13} />
              </button>
              <span className="tabular-nums">
                {idx + 1} / {total}
              </span>
              <button
                type="button"
                disabled={idx === total - 1}
                onClick={() => setRawIdx(idx + 1)}
                aria-label={t('dock.next')}
                className="grid h-5 w-5 place-items-center rounded transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <ChevronRight size={13} />
              </button>
            </span>
          </div>
        ) : null}
        <ProposalCard key={p.id} proposal={p} />
      </Dock>
    );
  }

  if (asks.length > 0) {
    return (
      <Dock>
        {asks.map((a) => (
          <AskUserChoiceCard key={a.askId} ask={{ ...a, conversationId }} />
        ))}
      </Dock>
    );
  }

  return null;
}

/** 停靠层外壳：贴在输入框上方，与输入区一体。 */
function Dock({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 flex flex-col gap-2">{children}</div>;
}
