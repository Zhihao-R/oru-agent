/**
 * 任务列表单行：
 *   [│][状态图标] [标题]                              [@归属] [#tag] [💬N]
 *
 * - 选中态：左 2px accent bar + 浅 hover 背景（不用 accent-soft，避免和 sidebar 撞色）
 * - 状态图标点击 → 弹 StatusMenu
 * - 行体点击 → selectTask(task.id) 打开右侧详情面板
 * - 已完成行：标题置灰 + 删除线
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import type { BoardTaskMeta } from '@shared/types';
import { useTaskboardStore } from '@/stores/taskboardStore';
import { cn } from '@/lib/cn';
import { StatusBadge } from './StatusBadge';
import { StatusMenu } from './StatusMenu';

export function TaskRow({ task }: { task: BoardTaskMeta }) {
  const { t } = useTranslation('taskboard');
  const selectTask = useTaskboardStore((s) => s.selectTask);
  const selectedTaskId = useTaskboardStore((s) => s.selectedTaskId);
  const [menuOpen, setMenuOpen] = useState(false);
  const badgeRef = useRef<HTMLButtonElement>(null);

  const isSelected = selectedTaskId === task.id;
  const isDone = task.status === '已完成';

  return (
    <div
      className={cn(
        'group -ml-0.5 flex cursor-pointer items-center gap-2.5 rounded-md border-l-2 border-transparent py-1.5 pl-1.5 pr-2 transition-colors',
        isSelected ? 'border-accent bg-hover' : 'hover:bg-hover',
      )}
      onClick={() => selectTask(task.id)}
    >
      <StatusBadge
        ref={badgeRef}
        status={task.status}
        clickable
        size={14}
        className="h-5 w-5"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
      />
      <div
        className={cn(
          'min-w-0 flex-1 truncate text-sm',
          isDone ? 'text-text-tertiary line-through decoration-text-tertiary/60' : 'text-text-primary',
        )}
      >
        {task.title}
      </div>
      <div className="flex shrink-0 items-center gap-2.5 text-[11px] text-text-tertiary">
        <span className="inline-flex items-center gap-1">
          <span
            className={cn(
              'inline-block h-1 w-1 rounded-full',
              task.assignee === 'you' ? 'bg-text-tertiary/60' : 'bg-accent',
            )}
          />
          {t(`assignee.${task.assignee}`, { defaultValue: task.assignee })}
        </span>
        {task.projectTag ? (
          <span>
            <span className="text-text-tertiary/60">#</span>
            {task.projectTag}
          </span>
        ) : null}
        {task.commentCount > 0 ? (
          <span className="inline-flex items-center gap-0.5">
            <MessageSquare size={11} strokeWidth={1.5} />
            {task.commentCount}
          </span>
        ) : null}
      </div>
      {menuOpen ? (
        <StatusMenu
          taskId={task.id}
          currentStatus={task.status}
          anchorRef={badgeRef}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
    </div>
  );
}
