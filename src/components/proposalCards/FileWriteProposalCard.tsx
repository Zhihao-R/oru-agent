/**
 * 本地文件写提案卡（write_file / edit_file / manage_files-delete）。
 *
 * - create：路径 + 内容预览
 * - overwrite / edit：旧→新 diff（proposal.diff）
 * - delete：路径 + "将移入回收站（可恢复）"
 *
 * 交互复用现有 proposal.execute / proposal.discard（对照 DeckCreateProposalCard）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { FilePlus, FolderInput, type LucideIcon, Pencil, Trash2 } from 'lucide-react';
import type { FileWriteProposal } from '@shared/types';
import { behaviorForProposal } from '@shared/proposals/behaviors';
import { wsClient } from '@/lib/ws';
import { useTaskStore } from '@/stores/taskStore';
import { useDirtyFileHit } from '@/lib/dirtyFiles';
import { DiffBlock } from '../diff/DiffBlock';
import { ProposalTerminalLine } from './ProposalTerminalLine';
import { AlwaysAllowButton } from './AlwaysAllowButton';
import { Button } from '../ui/Button';

/** 各模式的线性图标（与骨架同套 lucide）；verb/approve 文案经 proposal ns 翻译。 */
const MODE_ICON: Record<FileWriteProposal['mode'], LucideIcon> = {
  create: FilePlus,
  overwrite: Pencil,
  edit: Pencil,
  append: FilePlus,
  delete: Trash2,
  move: FolderInput,
  rename: Pencil,
};

export function FileWriteProposalCard({ proposal }: { proposal: FileWriteProposal }) {
  const { t } = useTranslation('proposal');
  const [submitting, setSubmitting] = useState(false);
  const removeProposal = useTaskStore((s) => s.removeProposal);
  const isPending = proposal.status === 'pending';
  const Icon = MODE_ICON[proposal.mode];
  // 行为分类（决策 1）：弹卡的写（删除 / 覆盖）标题写行为类型，描述写具体对象（路径在下方）
  const behavior = behaviorForProposal(proposal);
  const asksApproval = proposal.mode === 'delete' || proposal.mode === 'overwrite';
  const verb = t(`file.${proposal.mode}Verb`);
  const approve = t(`file.${proposal.mode}Approve`);
  // 阻断态：目标文件在编辑器里有未保存草稿 → 不可批准（AI 动手基于磁盘确认版）；⌘S 后自动恢复
  const blockedByDraft = useDirtyFileHit([proposal.path]);

  const onApprove = async (always: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await wsClient.request({ type: 'proposal.execute', proposalId: proposal.id, always });
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
          <Icon size={13} strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-primary">
            {asksApproval && behavior ? t(behavior.titleKey) : verb}
          </div>
          <div className="mt-0.5 break-all font-mono text-xs text-text-secondary">{proposal.path}</div>
        </div>
      </div>

      {/* 不可逆副作用警示（编码转换）：确认按钮就在下面，警示必须在按之前看得见 */}
      {proposal.caution && (
        <div className="mt-2 rounded-md bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
          {t(`file.caution.${proposal.caution}`)}
        </div>
      )}

      {/* 内容预览 / diff */}
      <div className="mt-2">
        {proposal.mode === 'create' && proposal.content !== undefined ? (
          <CodeBlock text={truncate(proposal.content, 2000, t)} />
        ) : proposal.mode === 'delete' ? (
          <div className="text-xs text-text-tertiary">{t('file.deleteHint')}</div>
        ) : proposal.mode === 'move' && proposal.destDir ? (
          <div className="break-all font-mono text-xs text-text-tertiary">→ {proposal.destDir}</div>
        ) : proposal.mode === 'rename' && proposal.newName ? (
          <div className="break-all font-mono text-xs text-text-tertiary">→ {proposal.newName}</div>
        ) : proposal.diff ? (
          <DiffBlock diff={proposal.diff} />
        ) : null}
      </div>

      {!isPending ? (
        // 非 pending：只留一行终态存证（G31）
        <ProposalTerminalLine proposal={proposal} />
      ) : (
        <div className="mt-3 flex items-center justify-end gap-2">
          {blockedByDraft && (
            <span className="mr-auto rounded-md bg-warn-soft px-2.5 py-1 text-xs text-warn">
              {t('file.blockedDraft', { file: blockedByDraft })}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => void onDiscard()}
            disabled={submitting}
          >
            {t('nevermind')}
          </Button>
          <AlwaysAllowButton
            proposal={proposal}
            onClick={() => void onApprove(true)}
            disabled={submitting || !isPending || blockedByDraft !== null}
          />
          {/* delete 模式映射 dangerSolid（红），其余 primary（不变量：破坏性确认必须红） */}
          <Button
            variant={proposal.mode === 'delete' ? 'dangerSolid' : 'primary'}
            size="sm"
            type="button"
            onClick={() => void onApprove(false)}
            disabled={submitting || !isPending || blockedByDraft !== null}
          >
            {submitting ? t('processing') : approve}
          </Button>
        </div>
      )}
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-60 overflow-auto rounded-md bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-text-secondary">
      {text}
    </pre>
  );
}

function truncate(s: string, max: number, t: TFunction): string {
  return s.length > max ? `${s.slice(0, max)}${t('file.truncated', { count: s.length })}` : s;
}
