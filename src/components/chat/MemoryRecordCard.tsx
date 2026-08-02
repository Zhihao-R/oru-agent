/**
 * 记忆系统的"已记下 X" 卡片
 *
 * 出现在聊天流里，由 chat.memoryRecord 事件触发。卡片不消失——作为对话记录的
 * 一部分往回滚就能看到。两按钮：撤回 / 查看（查看交给宿主开浮层）。没有「改」——
 * 档案浮层自带 ✎，事件笔记则只能重记，卡片上再放一个编辑入口无处可去。
 *
 * 事件记忆与档案记忆的撤回不是一回事：前者一文件一条，撤销＝整条移进回收站；后者是一份连续
 * 文档里的一段，只能「回到这次写入之前那一版」，且这之后档案没再被动过才允许（见 memory/revert.ts）。
 */
import { Bookmark, Undo2, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { wsClient } from '@/lib/ws';
import type { ChatMessage, MemoryRecordPayload } from '@shared/types';
import { cn } from '@/lib/cn';
import { useOruName } from '@/lib/oruName';
import { useChatStore } from '@/stores/chatStore';
import { useAgentStore } from '@/stores/agentStore';
import { useProjectStore } from '@/stores/projectStore';
import { memoryDocTitle, projectIdOf } from './memoryDocTitle';

type Props = {
  message: ChatMessage; // kind === 'memory-record'
  onView: (record: MemoryRecordPayload) => void;
};

// self（含历史 persona）类型在卡片上 scope 显示为"{name} 自我"——scope.agent 的"{name} 关系"
// 是 episode 语境的措辞，套到自我画像上会让用户分不清是关系还是自我。（称呼收敛：接个体名）
function scopeLabelFor(scope: string, type: string, name: string, t: TFunction): string {
  if (type === 'self' || type === 'persona') return t('memoryCard.scopePersona', { name });
  return t(`memoryCard.scope.${scope}`, { name, defaultValue: scope });
}

export function MemoryRecordCard({ message, onView }: Props) {
  const payload = message.memoryRecord;
  if (!payload) return null;
  return <Card message={message} record={payload} onView={onView} />;
}

function Card({
  message,
  record,
  onView,
}: {
  message: ChatMessage;
  record: MemoryRecordPayload;
  onView: (record: MemoryRecordPayload) => void;
}) {
  const { t } = useTranslation('chat');
  const { t: th } = useTranslation('home');
  // 记忆卡渲染在当前活跃对话流里，scope（自我/关系）指 active agent 的记忆——active 即上下文 agent。
  const oruName = useOruName();
  const projectName = useProjectStore((s) => {
    const pid = projectIdOf(record.relPath);
    return s.projects.find((p) => p.id === pid)?.name ?? pid;
  });

  // 档案记忆的撤回只对「这份档案最近一次修改」成立——之后又改过就会连带抹掉后来的改动。
  // 这里按同一对话流里有没有更晚的同档案卡片做乐观判定（覆盖连着改几次的主场景），
  // 跨对话 / 用户自己在浮层里改则由主进程撤回时权威校验兜住（resolveRevertTarget）。
  const supersededHere = useChatStore((s) => {
    if (!record.revertHash) return false;
    const msgs = s.conversations[message.conversationId] ?? [];
    let latest: string | null = null;
    for (const m of msgs) {
      if (m.kind === 'memory-record' && m.memoryRecord?.relPath === record.relPath && m.memoryRecord.revertHash) {
        latest = m.id;
      }
    }
    return latest !== null && latest !== message.id;
  });

  const undone = record.undone === true;
  const isDoc = !!record.revertHash;
  const docTitle = memoryDocTitle(record, { oruName, projectName, t: th });

  const onUndo = async () => {
    if (undone) return;
    // 置灰态仍可点（aria-disabled 而非 disabled：disabled 的按钮 Tab 不到、也没有 hover，
    // 理由就只剩鼠标用户看得见——那正是刚删掉的「改一下」的毛病）。点了直接说明，不走确认框。
    if (supersededHere) {
      alert(t('memoryCard.revertSuperseded'));
      return;
    }
    const ask = isDoc
      ? t('memoryCard.revertConfirm', { title: docTitle })
      : t('memoryCard.undoConfirm', { preview: record.preview });
    if (!confirm(ask)) return;
    try {
      await wsClient.request({
        type: 'memory.undo',
        agentId: useAgentStore.getState().activeAgentId ?? '',
        conversationId: message.conversationId,
        messageId: message.id,
        relPath: record.relPath,
        revertHash: record.revertHash,
      });
      // 状态由 chat.memoryUndone 事件回推
    } catch (e) {
      // ws 把 message 拼成 `${code}: ${message}`，code 另挂在 error 上——上屏只要人话那半截
      const err = e as Error & { code?: string };
      const detail = err.code ? err.message.replace(`${err.code}: `, '') : err.message;
      alert(
        isDoc
          ? t('memoryCard.revertFailed', { error: detail })
          : t('memoryCard.undoFailed', { error: detail }),
      );
    }
  };

  // 记忆卡是第 4 层「存证与系统事件」淡卡（设计稿），安静沉底、不用 accent 高亮抢戏
  return (
    <div
      className={cn(
        'rounded-sm border border-border px-4 py-3 text-sm transition-opacity',
        undone ? 'bg-elevated/40 opacity-60' : 'bg-sunken-2',
      )}
    >
      <div className="flex items-start gap-3">
        <Bookmark className="mt-0.5 shrink-0 text-text-tertiary" size={14} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium text-text-primary">
              {undone ? t('memoryCard.undone') : t('memoryCard.recorded')}
            </span>
            <span className="text-xs text-text-tertiary">
              {scopeLabelFor(record.scope, record.type, oruName, t)} ·{' '}
              {t(`memoryCard.type.${record.type}`, { defaultValue: record.type })}
            </span>
          </div>
          <RecordBody record={record} docTitle={docTitle} undone={undone} t={t} />
          {!undone ? (
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={onUndo}
                aria-disabled={supersededHere || undefined}
                title={supersededHere ? t('memoryCard.revertSuperseded') : undefined}
                className={cn(
                  'inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-elevated',
                  supersededHere ? 'text-text-quaternary' : 'text-text-secondary',
                )}
              >
                <Undo2 size={12} /> {isDoc ? t('memoryCard.revert') : t('memoryCard.undo')}
              </button>
              <button
                type="button"
                onClick={() => onView(record)}
                className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs text-text-secondary hover:bg-elevated"
              >
                <Eye size={12} /> {t('memoryCard.view')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 卡片正文要回答的是「改了什么」——只贴新内容的话，用户没有判断该不该撤回的依据。
 *  - 改了一段（edit_memory）：旧的划掉 + 新的在下；删掉一段则只有划掉那行 + 一句说明
 *  - 整篇覆盖（write_memory）：给不出诚实的片段摘要，主进程留空 preview，这里说明改了哪份档案
 *  - 事件记忆：preview 就是标题，本就代表整条
 *
 * 长段落靠 line-clamp 收视觉、不在数据里截——截断落盘会让「差异在截断点之后」的两行看起来一样。
 */
function RecordBody({
  record,
  docTitle,
  undone,
  t,
}: {
  record: MemoryRecordPayload;
  docTitle: string;
  undone: boolean;
  t: TFunction;
}) {
  const CLAMP = 'line-clamp-3 break-words';
  const bodyClass = cn('mt-1', CLAMP, undone ? 'text-text-tertiary line-through' : 'text-text-primary');
  if (record.replaced) {
    return (
      <>
        <div className={cn('mt-1', CLAMP, 'text-text-quaternary line-through')}>{record.replaced}</div>
        {record.preview ? (
          <div className={cn(CLAMP, undone ? 'text-text-tertiary line-through' : 'text-text-primary')}>
            {record.preview}
          </div>
        ) : (
          <div className="text-xs text-text-tertiary">{t('memoryCard.sectionDeleted')}</div>
        )}
      </>
    );
  }
  if (!record.preview) {
    const changes = record.sections ? sectionSummary(record.sections, t) : '';
    return (
      <>
        <div className={cn(bodyClass, 'text-text-tertiary')}>
          {t('memoryCard.wholeDocRewritten', { title: docTitle })}
        </div>
        {changes ? <div className="text-xs text-text-tertiary">{changes}</div> : null}
      </>
    );
  }
  return <div className={bodyClass}>{record.preview}</div>;
}

/** 「新增「饮食习惯」，改写「作息」，删除「工作节奏」」——小节名直接取自档案结构，不编摘要。 */
function sectionSummary(delta: NonNullable<MemoryRecordPayload['sections']>, t: TFunction): string {
  const parts = [
    delta.added.length ? t('memoryCard.sectionsAdded', { names: delta.added.join(t('memoryCard.sectionSep')) }) : '',
    delta.changed.length ? t('memoryCard.sectionsChanged', { names: delta.changed.join(t('memoryCard.sectionSep')) }) : '',
    delta.removed.length ? t('memoryCard.sectionsRemoved', { names: delta.removed.join(t('memoryCard.sectionSep')) }) : '',
  ].filter(Boolean);
  return parts.join(t('memoryCard.sectionSep'));
}
