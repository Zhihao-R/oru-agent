/**
 * 网页访问提案卡（S04 投递档）：web_fetch 抓取与 browser_navigate 打开（S33）同族共用——
 * 都是「模型自拟的外部地址要不要访问」这一个决定，仅文案按 kind 取词。
 * 沿用 bash/file.write 同一套同步审批接线（proposal.execute / proposal.reject）。
 * 用户自己给的链接不会走到这张卡（地址逐字判定在主进程免闸）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import type { BrowserNavigateProposal, WebFetchProposal } from '@shared/types';
import { behaviorForProposal } from '@shared/proposals/behaviors';
import { wsClient } from '@/lib/ws';
import { RejectNoteDisclosure } from './RejectNoteDisclosure';
import { ProposalTerminalLine } from './ProposalTerminalLine';
import { AlwaysAllowButton } from './AlwaysAllowButton';
import { Button } from '../ui/Button';

export function WebAccessProposalCard({
  proposal,
}: {
  proposal: WebFetchProposal | BrowserNavigateProposal;
}) {
  const { t } = useTranslation('proposal');
  const ns = proposal.kind === 'web.fetch' ? 'webFetch' : 'browserNavigate';
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState('');
  const isPending = proposal.status === 'pending';
  // 行为分类（决策 1）：标题写行为类型「访问网站」，描述写具体对象（URL 在下方）
  const behavior = behaviorForProposal(proposal);

  const onApprove = (always: boolean) => submit({ type: 'proposal.execute', always });
  const onReject = () => submit({ type: 'proposal.reject', note: note.trim() || undefined });

  const submit = async (
    req:
      | { type: 'proposal.execute'; always: boolean }
      | { type: 'proposal.reject'; note?: string },
  ) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await wsClient.request({ ...req, proposalId: proposal.id });
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-sm border border-accent-ring bg-elevated shadow-soft">
      <div className="flex items-center gap-2 bg-accent-soft px-4 py-2.5 font-mono text-xs font-semibold tracking-wide text-accent">
        <Globe size={14} /> {behavior ? t(behavior.titleKey) : t(`${ns}.pending`)}
      </div>
      <div className="px-4 py-3 text-sm">
        <div className="text-text-secondary">{t(`${ns}.hint`)}</div>
        <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-sunken px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
          {proposal.url}
        </pre>
      </div>

      {!isPending ? (
        // 非 pending：只留一行终态存证（G31），执行过程与成败由对话流展示
        <div className="px-4 pb-3">
          <ProposalTerminalLine proposal={proposal} />
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-4 pb-3">
          <div className="flex justify-end">
            <RejectNoteDisclosure note={note} setNote={setNote} disabled={submitting} />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => void onReject()}
              disabled={submitting}
            >
              {t('decline')}
            </Button>
            <AlwaysAllowButton
              proposal={proposal}
              onClick={() => void onApprove(true)}
              disabled={submitting || !isPending}
            />
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => void onApprove(false)}
              disabled={submitting || !isPending}
            >
              {submitting ? t('processing') : t(`${ns}.confirm`)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
