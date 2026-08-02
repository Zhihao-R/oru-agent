/**
 * 定时任务写操作提案卡（Oru 在对话里建/改/删定时任务时）。
 * 沿用 bash/file.write 同一套同步审批接线（proposal.execute / proposal.reject）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import type { ScheduledTaskProposal } from '@shared/types';
import { behaviorForProposal } from '@shared/proposals/behaviors';
import { describeSpec, describeFrequency } from '@shared/scheduledTasks/describe';
import { describeWhen } from '@/lib/scheduledTaskFormat';
import { wsClient } from '@/lib/ws';
import { RejectNoteDisclosure } from './RejectNoteDisclosure';
import { ProposalTerminalLine } from './ProposalTerminalLine';
import { AlwaysAllowButton } from './AlwaysAllowButton';
import { Button } from '../ui/Button';

export function ScheduledTaskProposalCard({
  proposal,
  onResolved,
}: {
  proposal: ScheduledTaskProposal;
  onResolved?: () => void;
}) {
  const { t } = useTranslation('proposal');
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState('');
  const isPending = proposal.status === 'pending';
  const draft = proposal.draft;
  // 行为分类（决策 1）：标题写行为类型「创建自动化任务」，动作与对象在下方描述行
  const behavior = behaviorForProposal(proposal);

  const onApprove = (always: boolean) => submit({ type: 'proposal.execute', always });
  const onReject = () => submit({ type: 'proposal.reject', note: note.trim() || undefined }); // 拒绝附言（G02）

  const submit = async (
    req:
      | { type: 'proposal.execute'; always: boolean }
      | { type: 'proposal.reject'; note?: string },
  ) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await wsClient.request({ ...req, proposalId: proposal.id });
      onResolved?.();
    } catch {
      setSubmitting(false);
    }
  };

  const stopText = draft?.stopAfterRuns
    ? t('scheduledTask.stopAfter', { count: draft.stopAfterRuns })
    : t('scheduledTask.stopNever');
  // 多规则（>1 条触发时间）逐条列频率；单规则/删停走 draft 单行（与原来逐像素一致）
  const multiRules = (proposal.rules?.length ?? 0) > 1 ? proposal.rules : null;

  return (
    <div className="overflow-hidden rounded-sm border border-accent-ring bg-elevated shadow-soft">
      <div className="flex items-center gap-2 bg-accent-soft px-4 py-2.5 font-mono text-xs font-semibold tracking-wide text-accent">
        <Clock size={14} /> {behavior ? t(behavior.titleKey) : t('scheduledTask.pending')}
      </div>
      <div className="px-4 py-3 text-sm">
        <div className="text-text-secondary">{proposal.description}</div>
        {draft ? (
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base">
            <span className="text-text-tertiary">{t('scheduledTask.kvExecContent')}</span>
            <span className="font-medium text-text-primary">{draft.prompt}</span>
            <span className="text-text-tertiary">{t('scheduledTask.kvTrigger')}</span>
            {/* 一次性显示解析后的人话时刻（如「今天 18:00」）——让用户在确认卡上识破「未来的错日期」，
                而非干巴巴的「一次性」（tech §F）。周期任务仍显示频率描述（已自含钟点）。
                多规则时逐条列出（频率经 describeFrequency 已含「共 N 次」，故合并到触发行、不另起停止行）。 */}
            {multiRules ? (
              <span className="font-medium text-text-primary">
                {multiRules.map((r, i) => (
                  <span key={i} className="block">
                    {r.spec.kind === 'once' && r.nextRunAt != null
                      ? describeWhen(r.nextRunAt)
                      : describeFrequency(r.spec, r.stopAfterRuns, t)}
                  </span>
                ))}
              </span>
            ) : (
              <span className="font-medium text-text-primary">
                {draft.spec.kind === 'once' && draft.nextRunAt != null
                  ? describeWhen(draft.nextRunAt)
                  : describeSpec(draft.spec, t)}
              </span>
            )}
            <span className="text-text-tertiary">{t('scheduledTask.kvLocation')}</span>
            <span className="font-medium text-text-primary">
              {draft.runLocation.kind === 'newConversation'
                ? t('scheduledTask.locNewConv')
                : draft.runLocation.kind === 'channel'
                  ? t('scheduledTask.locChannel', { platform: draft.runLocation.platform === 'feishu' ? t('scheduledTask.platformFeishu') : 'Discord' })
                  : t('scheduledTask.locSpecified')}
            </span>
            {!multiRules && (proposal.action === 'create' || proposal.action === 'update') ? (
              <>
                <span className="text-text-tertiary">{t('scheduledTask.kvStop')}</span>
                <span className="font-medium text-text-primary">{stopText}</span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {!isPending ? (
        // 非 pending：只留一行终态存证（G31）
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
              {submitting ? t('processing') : t('scheduledTask.confirm')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
