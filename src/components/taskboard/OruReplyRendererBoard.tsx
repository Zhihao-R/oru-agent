/**
 * 评论场景 Oru 回复的精简渲染：
 * - 文本：与用户评论同款 text-sm 无装饰，没有 markdown 格式（评论场景以平白文字为主，
 *   要保持与用户评论字体/字号视觉一致——勿用 ChatMarkdown，否则会回退到 .oru-chat-md
 *   的 15px / line-height:1.75 衬线样式，让 Oru 行字体显著大于"你"行）
 * - streaming 时尾部光标
 * - 空态 + 仍在 streaming：内联思考中点点点（chat.started 后 chat.delta 前的等待）
 * - 写类工具调用 → 注脚 `── 过程中：已 XX`
 * - error / aborted / retrying → 状态行
 * - done + 有 toolCalls → "查看完整过程" 折叠按钮
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ChatMessage, ToolCall } from '@shared/types';
import { cn } from '@/lib/cn';

const WRITE_TOOL_NAMES = new Set([
  'create_task',
  'update_task',
  'delete_task',
  'restore_task',
]);

function shortId(id: unknown): string {
  if (typeof id !== 'string') return '???';
  return id.length > 10 ? id.slice(0, 10) : id;
}

function describePatch(patch: unknown, t: TFunction): string {
  if (!patch || typeof patch !== 'object') return t('reply.fieldAdjust');
  const fields = Object.keys(patch as Record<string, unknown>);
  if (fields.length === 0) return t('reply.fieldAdjust');
  return fields.join(' / ');
}

/** 把工具调用映射成简洁注脚；非写类返回 null */
export function writeOpFootnote(call: ToolCall, t: TFunction): string | null {
  const input = call.input as Record<string, unknown>;
  switch (call.name) {
    case 'create_task': {
      const title = typeof input.title === 'string' ? input.title : '?';
      return t('reply.created', { title });
    }
    case 'update_task': {
      const id = shortId(input.id);
      return t('reply.updated', { id, patch: describePatch(input.fields, t) });
    }
    case 'delete_task': {
      return t('reply.deleted', { id: shortId(input.id) });
    }
    case 'restore_task': {
      return t('reply.restored', { id: shortId(input.id) });
    }
    default:
      return null;
  }
}

function deriveWriteNotes(calls: ToolCall[], t: TFunction): string[] {
  return calls
    .filter((c) => WRITE_TOOL_NAMES.has(c.name) && c.status === 'success')
    .map((c) => writeOpFootnote(c, t))
    .filter((s): s is string => s !== null);
}

export function OruReplyRendererBoard({ message }: { message: ChatMessage }) {
  const { t } = useTranslation('taskboard');
  const [showProcess, setShowProcess] = useState(false);
  const writeNotes = useMemo(() => deriveWriteNotes(message.toolCalls, t), [message.toolCalls, t]);
  const errored = message.error != null;
  const aborted = !!message.abortedByUser;
  const retrying = (message.retryAttempt ?? 0) > 0 && !message.done;
  const streaming = !message.done && !errored && !aborted;
  const hasContent = message.text.length > 0 || message.toolCalls.length > 0;

  return (
    <div>
      {hasContent ? (
        <div className="whitespace-pre-wrap break-words text-sm text-text-primary">
          {message.text}
          {streaming ? <span className="ml-0.5 animate-pulse text-text-tertiary">▍</span> : null}
        </div>
      ) : streaming ? (
        <div className="flex items-center gap-0.5 text-text-tertiary">
          <span className="animate-pulse">●</span>
          <span className="animate-pulse" style={{ animationDelay: '120ms' }}>●</span>
          <span className="animate-pulse" style={{ animationDelay: '240ms' }}>●</span>
        </div>
      ) : null}
      {writeNotes.length > 0 ? (
        <div className="mt-2 space-y-0.5">
          {writeNotes.map((n, i) => (
            <div key={i} className="text-xs text-text-tertiary">{t('reply.processNote', { note: n })}</div>
          ))}
        </div>
      ) : null}
      {errored ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-danger bg-danger-soft px-2 py-1 text-xs text-danger">
          <span>⚠ {message.error?.message}</span>
          {message.error?.retryable ? (
            <span className="text-text-tertiary">{t('reply.retryHint')}</span>
          ) : null}
        </div>
      ) : null}
      {aborted ? <div className="mt-2 text-xs text-text-tertiary">{t('reply.aborted')}</div> : null}
      {retrying ? (
        <div className="mt-2 text-xs text-text-tertiary">{t('reply.retrying')}</div>
      ) : null}
      {message.done && message.toolCalls.length > 0 && !errored ? (
        <button
          type="button"
          onClick={() => setShowProcess((v) => !v)}
          className="mt-2 text-[11px] text-text-tertiary hover:text-text-secondary"
        >
          {showProcess ? t('reply.collapseProcess') : t('reply.viewProcess')}
        </button>
      ) : null}
      {showProcess ? (
        <div className="mt-2 space-y-1.5 rounded-md border border-border bg-elevated/50 px-2 py-2 text-[11px] text-text-tertiary">
          {message.toolCalls.map((c) => (
            <ToolCallDetail key={c.id} call={c} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolCallDetail({ call }: { call: ToolCall }) {
  const statusTone =
    call.status === 'error'
      ? 'text-danger'
      : call.status === 'success'
        ? 'text-success'
        : 'text-text-tertiary';
  return (
    <div>
      <div className={cn('font-mono', statusTone)}>
        {call.name}({JSON.stringify(call.input).slice(0, 200)})
      </div>
      {call.result ? (
        <div className="ml-2 mt-0.5 whitespace-pre-wrap break-words text-text-tertiary">
          → {(call.result.summary ?? '').slice(0, 300)}
        </div>
      ) : null}
    </div>
  );
}
