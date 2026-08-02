/**
 * 评论线主体：拉历史 + 渲染消息列表 + Oru 思考中（条件）+ 输入框。
 *
 * - 挂载时调 commentStore.loadHistory(taskId)
 * - 消息列表来自 messagesByTaskId
 * - oruRunningByTaskId 为 true 时尾部显示 OruThinkingRow
 * - 自动滚到底（新消息到来 / 加载历史完成时）
 *
 * 视觉：默认无外层 border / bg——融在详情侧栏里。空态只用一个标题 + 输入框，
 * 不再叠"还没有评论"灰字（PR-D3 设计语义重复，新版去掉）。
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '@shared/types';
import { useTaskboardCommentStore } from '@/stores/taskboardCommentStore';
import { CommentRow } from './CommentRow';
import { OruThinkingRow } from './OruThinkingRow';
import { CommentInput } from './CommentInput';

// 稳定空数组：selector 返回新 [] 会让 zustand 默认 Object.is 视为变化 → 死循环
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

export function CommentThread({ taskId }: { taskId: string }) {
  const { t } = useTranslation('taskboard');
  const messages = useTaskboardCommentStore(
    (s) => s.messagesByTaskId[taskId] ?? (EMPTY_MESSAGES as ChatMessage[]),
  );
  const oruRunning = useTaskboardCommentStore((s) => s.oruRunningByTaskId[taskId] ?? false);
  const loadHistory = useTaskboardCommentStore((s) => s.loadHistory);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadHistory(taskId);
  }, [taskId, loadHistory]);

  // 新消息或思考态变化时滚到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, oruRunning]);

  const hasContent = messages.length > 0 || oruRunning;
  // chat.started 后 store 已经插了一条 streaming 的 assistant placeholder，
  // 此时如果再叠 OruThinkingRow 就会出现"空 Oru 行 + 思考中"两条。
  // 所以只在还没有 streaming assistant 时（chat.started 前的窗口）才显示思考行。
  const hasStreamingAssistant = messages.some((m) => m.role === 'assistant' && !m.done);

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          {t('comment.heading')}
        </span>
        <span className="text-[11px] tabular-nums text-text-tertiary/70">
          {messages.length}
        </span>
      </div>
      {hasContent ? (
        <div className="mb-2 flex flex-col">
          {messages.map((m) => (
            <CommentRow key={m.id} taskId={taskId} message={m} />
          ))}
          {oruRunning && !hasStreamingAssistant ? <OruThinkingRow /> : null}
          <div ref={bottomRef} />
        </div>
      ) : null}
      <CommentInput taskId={taskId} />
    </div>
  );
}
