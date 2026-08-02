/**
 * bash 命令执行提案卡。
 *
 * - 始终展示完整命令（<pre>）+ description（若有）
 * - isDestructive：命令框内染红危险段定位 + 顶部红字说为什么危险
 *   （看不透→统一「危险命令」；看得透的具体危险→具体 reason，多段去重「、」连）
 *
 * 风险展示为何比其它卡重：FileWrite/Deck 的危险是结构化的（mode=delete），一个红按钮就够；
 * bash 是自由文本、危险藏在子串里，故需框内染红定位 + 顶部具体原因。新增卡按此分层选轻重。
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from 'lucide-react';
import type { BashProposal } from '@shared/types';
import { behaviorForProposal } from '@shared/proposals/behaviors';
import { wsClient } from '@/lib/ws';
import { useDirtyFileHit } from '@/lib/dirtyFiles';
import { RejectNoteDisclosure } from './RejectNoteDisclosure';
import { ProposalTerminalLine } from './ProposalTerminalLine';
import { AlwaysAllowButton } from './AlwaysAllowButton';
import { CopyButton } from '../ui/CopyButton';
import { Button } from '../ui/Button';

/**
 * 在完整命令里把危险段染红——段是原文有序子串，用游标 indexOf 逐段定位回原文。
 * 看不透时危险段=整条命令 → 整条变红；能拆段时只染危险子串，精确指向哪段危险。
 */
function highlightDanger(command: string, dangerTexts: string[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  const pushPlain = (text: string) => {
    if (text) nodes.push(<span key={key++}>{text}</span>);
  };
  for (const text of dangerTexts) {
    const idx = command.indexOf(text, cursor);
    if (idx < 0) continue;
    pushPlain(command.slice(cursor, idx));
    nodes.push(
      <span key={key++} className="text-danger">
        {command.slice(idx, idx + text.length)}
      </span>,
    );
    cursor = idx + text.length;
  }
  pushPlain(command.slice(cursor));
  return nodes;
}

export function BashProposalCard({
  proposal,
  onResolved,
}: {
  proposal: BashProposal;
  /** 同意 / 算了成功后回调——carousel 据此翻到下一待处理页（单卡场景不传） */
  onResolved?: () => void;
}) {
  const { t } = useTranslation('proposal');
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState('');
  const isPending = proposal.status === 'pending';
  // 行为分类（决策 1）：标题写行为类型（破坏性命令 / 未知命令 / 发送内容到外部 / 覆盖既有内容）
  const behavior = behaviorForProposal(proposal);
  // 阻断态（表格 PRD「AI 与草稿的分工」）：命令命中编辑器里的脏文件 → 不可批准；
  // ⌘S 保存后脏集变化，卡片自动恢复可批。main 执行前还有同步拉脏集的硬闸兜底。
  const blockedByDraft = useDirtyFileHit([proposal.command]);
  const overwriteTargets = proposal.overwriteTargets ?? [];
  const destructiveSegments = proposal.segments.filter((s) => s.destructive);
  // 顶部红字：具体危险原因（多段去重「、」连）；未知命令（opaque）的 reason 是看不透的结构说明
  const specificReasons = [
    ...new Set(destructiveSegments.map((s) => s.reason).filter((r): r is string => !!r)),
  ];
  const dangerLabel = specificReasons.join(t('common:listSeparator'));

  // 「允许」→ always:false（仅此一次）；「始终允许」→ always:true（写入持久授权清单，见 onAlwaysAllow）。
  const onApprove = async (always: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await wsClient.request({ type: 'proposal.execute', proposalId: proposal.id, always });
      onResolved?.();
    } catch {
      setSubmitting(false);
    }
  };
  // 「始终允许」（G30）：把本提案 grantable scope 写入持久授权清单，再执行本条。
  // 原「切到工作模式」弱链已删（PM 2026-07-13）：S24 后它不写任何授权，切完挡命令照旧逐条弹卡，
  // 承诺全落空；「始终允许」按钮即其正确替身。
  const onAlwaysAllow = () => onApprove(true);

  // 「算了」走 proposal.reject（非 discard）。reject vs discard 的选择标准是**语义**、不是抄哪个卡：
  // reject = 拒绝并告知模型（写「系统记」+ 转 rejected 留痕）；discard = 悄悄丢弃（前端 removeProposal、模型不知情）。
  // bash 要告知（模型据此续跑、不重复 propose），且 carousel 要成员集稳定（决策 2），故用 reject、不 removeProposal。
  // 注：FileWrite/Deck 仍用 discard，是历史选择——按此标准它们是否也该告知模型存疑，本期不动。
  const onDiscard = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      // 拒绝带可选附言（G02）——说明「为什么不批」，随系统记落进历史让 Oru 下轮看到。
      await wsClient.request({ type: 'proposal.reject', proposalId: proposal.id, note: note.trim() || undefined });
      onResolved?.();
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-sm border border-border-strong bg-elevated px-4 py-3 shadow-soft">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Terminal size={12} strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">
            {behavior ? t(behavior.titleKey) : t('bash.title')}
            {proposal.isDestructive && dangerLabel ? (
              <span className="ml-2 text-base font-medium text-danger">{dangerLabel}</span>
            ) : null}
          </div>
          {proposal.description && proposal.description !== proposal.command ? (
            <div className="mt-0.5 text-xs text-text-secondary">{proposal.description}</div>
          ) : null}
        </div>
      </div>

      {/* 火灰断路器：删根 / 抹盘 / 格式化级——即便危险模式也强制停下确认（审批模式 PRD）。仅 pending 时警示，落定后不再挂 */}
      {isPending && proposal.catastrophic && (
        <div className="mt-2 rounded-md border border-danger bg-danger-soft px-3 py-1.5 text-xs font-semibold text-danger">
          {t('bash.catastrophic')}
        </div>
      )}

      {/* 覆盖确认态：脚本声明的输出撞上已存在文件（红框提示，确认前文件不被触碰） */}
      {overwriteTargets.length > 0 && (
        <div className="mt-2 rounded-md border border-danger bg-danger-soft px-3 py-1.5 text-xs text-danger">
          {t('bash.willOverwrite', { targets: overwriteTargets.join(t('common:listSeparator')) })}
        </div>
      )}

      {/* 对外投递（S04）：将向环境之外的地址 / 收件人送出内容——发出即收不回，批准前看清目标 */}
      {isPending && (proposal.delivery?.length ?? 0) > 0 && (
        <div className="mt-2 rounded-md border border-warn bg-warn-soft px-3 py-1.5 text-xs text-warn">
          {t('bash.delivery', {
            targets: (proposal.delivery ?? [])
              .map((d) => d.recipient ?? d.label)
              .join(t('common:listSeparator')),
          })}
        </div>
      )}

      {/* 完整命令（bg-sunken：凹陷代码框）：危险段在框内染红定位，危险位置一眼可见；右上角复制按钮 */}
      <div className="relative mt-2">
        <pre className="max-h-48 overflow-auto rounded-md bg-sunken px-3 py-2 pr-8 font-mono text-xs leading-relaxed text-text-primary">
          {proposal.isDestructive
            ? highlightDanger(proposal.command, destructiveSegments.map((s) => s.text))
            : proposal.command}
        </pre>
        <CopyButton text={proposal.command} className="absolute right-1.5 top-1.5" />
      </div>

      {/* 阻断态：不可批准，保存后自动恢复 */}
      {isPending && blockedByDraft && (
        <div className="mt-2 rounded-md bg-warn-soft px-3 py-1.5 text-xs text-warn">
          {t('bash.blockedDraft', { file: blockedByDraft })}
        </div>
      )}

      {!isPending ? (
        // 非 pending：只留一行终态存证（G31），执行过程与成败由对话流展示
        <ProposalTerminalLine proposal={proposal} />
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex justify-end">
            <RejectNoteDisclosure note={note} setNote={setNote} disabled={submitting} />
          </div>
          <div className="flex items-center justify-end gap-2">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => void onDiscard()}
                disabled={submitting}
              >
                {t('decline')}
              </Button>
              {/* 「始终允许」（决策 1）：grantable 非空才出现——文案标注授权类别与粒度。
                  灾难级 / 不可持久授权目标 grantable 为空，只留允许 / 拒绝。 */}
              <AlwaysAllowButton
                proposal={proposal}
                onClick={() => void onAlwaysAllow()}
                disabled={submitting || !isPending || blockedByDraft !== null}
              />
              {/* 破坏性 / 覆盖 / 对外投递时映射 dangerSolid（红），否则 primary（不变量：破坏性确认必须红） */}
              <Button
                variant={
                  proposal.isDestructive || overwriteTargets.length > 0 || (proposal.delivery?.length ?? 0) > 0
                    ? 'dangerSolid'
                    : 'primary'
                }
                size="sm"
                type="button"
                onClick={() => void onApprove(false)}
                disabled={submitting || !isPending || blockedByDraft !== null}
              >
                {submitting
                  ? t('executing')
                  : proposal.isDestructive || overwriteTargets.length > 0 || (proposal.delivery?.length ?? 0) > 0
                    ? t('bash.approveDestructive')
                    : t('bash.allow')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
