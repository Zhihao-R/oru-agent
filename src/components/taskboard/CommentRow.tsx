/**
 * 评论行渲染：按 message.role 派发。
 * - user：头像 + 作者（你 / Oru / 真人 actor 翻译）+ 时间 + 文本
 * - assistant：头像 + Oru + 时间 + OruReplyRendererBoard
 * - system：context-compressed 等特殊卡片（评论场景仅 context-compressed 会触发）
 *
 * 头像左对齐于任务标题（CommentRow 不加左 padding，由 DetailBody 的 px-7 统一控制）。
 */
import { Fragment, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { ChatMessage } from '@shared/types';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { AttachmentGallery } from '@/components/ui/AttachmentGallery';
import { Avatar } from '@/components/ui/Avatar';
import { DeleteConfirm } from '@/components/ui/DeleteConfirm';
import { TwinAvatar } from '@/components/TwinAvatar';
import { useAgentStore } from '@/stores/agentStore';
import { useUserProfileStore } from '@/stores/userProfileStore';
import { useTaskboardCommentStore } from '@/stores/taskboardCommentStore';
import { OruReplyRendererBoard } from './OruReplyRendererBoard';
import { formatRelativeTime as formatTime } from '@/lib/formatRelativeTime';

const MENTION_REGEX = /(@oru\b)/gi;

/** 把 @oru 渲染成 chip（与 CommentInput overlay 同款） */
function renderUserText(text: string): ReactNode[] {
  if (!text) return [];
  const re = new RegExp(MENTION_REGEX);
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(<Fragment key={`t${i}`}>{text.slice(last, match.index)}</Fragment>);
      i += 1;
    }
    parts.push(
      <span key={`m${i}`} className="rounded bg-accent-soft px-0.5 text-accent">
        {match[0]}
      </span>,
    );
    i += 1;
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parts.push(<Fragment key={`t${i}`}>{text.slice(last)}</Fragment>);
  }
  return parts;
}

/** 评论者头像：actor=oru 用当前 agent 头像，actor=you 用用户 profile 头像（回落首字母圈） */
function CommenterAvatar({ actor }: { actor: 'you' | 'oru' }) {
  const { t } = useTranslation('taskboard');
  const oruAvatarPath = useAgentStore(
    (s) => s.agents.find((a) => a.id === s.activeAgentId)?.avatarPath ?? null,
  );
  const userAvatarPath = useUserProfileStore((s) => s.profile?.avatarPath ?? null);
  const userName = useUserProfileStore((s) => s.profile?.name ?? '');
  if (actor === 'oru') {
    return <TwinAvatar size={24} avatarPath={oruAvatarPath} />;
  }
  return (
    <Avatar size={24} avatarPath={userAvatarPath} name={userName} fallback={t('assignee.you')} />
  );
}

function CommentLayout({
  actor,
  meta,
  action,
  children,
}: {
  actor: 'you' | 'oru';
  meta: ReactNode;
  /** 右上角 hover 才现的操作（如删除）；仅用户评论传 */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="group flex gap-3 py-2">
      <CommenterAvatar actor={actor} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-xs text-text-tertiary">
          {meta}
          {action ? (
            <div className="ml-auto opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              {action}
            </div>
          ) : null}
        </div>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

/** 用户评论删除入口：hover 现的垃圾桶 + 二次确认（删除不可恢复，无回收站） */
function CommentDeleteAction({ taskId, messageId }: { taskId: string; messageId: string }) {
  const { t } = useTranslation('taskboard');
  const [confirm, setConfirm] = useState(false);
  const deleteComment = useTaskboardCommentStore((s) => s.deleteComment);
  return (
    <>
      <button
        type="button"
        aria-label={t('comment.delete')}
        title={t('comment.delete')}
        onClick={() => setConfirm(true)}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-hover hover:text-danger"
      >
        <Trash2 size={13} strokeWidth={1.6} />
      </button>
      <DeleteConfirm
        open={confirm}
        title={t('comment.deleteConfirmTitle')}
        description={t('comment.deleteConfirmBody')}
        onConfirm={() => {
          setConfirm(false);
          void deleteComment(taskId, messageId);
        }}
        onClose={() => setConfirm(false)}
      />
    </>
  );
}

export function CommentRow({ taskId, message }: { taskId: string; message: ChatMessage }) {
  const { t } = useTranslation('taskboard');
  const userName = useUserProfileStore((s) => s.profile?.name ?? '');
  if (message.role === 'user') {
    // 作者名读用户 profile.name，未设置回落"你"（当前单人；真人同事评论 v2 再按 mentions 区分）
    // 删除只对已落库评论开放（乐观项 conversationId==='__pending__'，删了可能被 applyNoteAdded 复活）
    const deletable = message.conversationId !== '__pending__';
    return (
      <CommentLayout
        actor="you"
        action={deletable ? <CommentDeleteAction taskId={taskId} messageId={message.id} /> : undefined}
        meta={
          <>
            <span className="font-medium text-text-secondary">{userName.trim() || t('assignee.you')}</span>
            <span>· {formatTime(message.createdAt)}</span>
          </>
        }
      >
        <div className="flex flex-col gap-1.5">
          <AttachmentGallery attachments={message.attachments ?? []} align="start" />
          {message.text.trim().length > 0 ? (
            <div className="whitespace-pre-wrap break-words text-sm text-text-primary">
              {renderUserText(message.text)}
            </div>
          ) : null}
        </div>
      </CommentLayout>
    );
  }

  if (message.role === 'assistant') {
    return (
      <CommentLayout
        actor="oru"
        meta={
          <>
            <span className="font-medium text-text-secondary">Oru</span>
            <span>· {formatTime(message.createdAt)}</span>
          </>
        }
      >
        <OruReplyRendererBoard message={message} />
      </CommentLayout>
    );
  }

  // system：仅 context-compressed 等特殊卡片走这里
  if (message.kind === 'context-compressed') {
    return (
      <div className="py-2">
        <div className="rounded-md border border-border bg-elevated/40 px-2 py-1.5 text-xs text-text-tertiary">
          {t('comment.contextCompressed')}
          {message.contextCompressed?.summaryText ? (
            <div className="mt-1 text-[11px]">{message.contextCompressed.summaryText.slice(0, 200)}</div>
          ) : null}
        </div>
      </div>
    );
  }

  if (message.kind === 'turn-terminator') {
    return (
      <div className="py-2 text-xs text-text-tertiary">{t('comment.turnInterrupted')}</div>
    );
  }

  // 其他 system kind 评论场景不会有；防御性渲染纯文本
  return (
    <div className="py-2 text-xs text-text-tertiary">
      <ChatMarkdown source={message.text} />
    </div>
  );
}
