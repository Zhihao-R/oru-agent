/**
 * 回收站视图：永久保留作存档，不自动清理。
 *
 * 布局：复用 TaskboardSidebar 左栏（用户从左栏点"回收站"进，从左栏点其他分组返）。
 * 主区只显示已删除任务列表 + 恢复按钮。
 *
 * 列表来自 store.tasks 中 deletedAt != null 的项；按 deletedAt desc 排。
 * 每行：标题 / 删除人 / 删除时间 / 原状态 / 原 tag / 恢复按钮
 * 不展开评论；不打开详情面板（恢复后才能编辑）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, RotateCcw } from 'lucide-react';
import type { BoardTaskMeta } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { toastError } from '@/lib/toast';
import { wsClient } from '@/lib/ws';
import { useTaskboardStore } from '@/stores/taskboardStore';
import { TaskboardSidebar } from './TaskboardSidebar';
import { NewTaskDialog } from './NewTaskDialog';
import { StatusBadge } from './StatusBadge';
import { formatRelativeTime as formatTime } from '@/lib/formatRelativeTime';

export function RecycleBinView() {
  const { t } = useTranslation('taskboard');
  const tasks = useTaskboardStore((s) => s.tasks);
  const loaded = useTaskboardStore((s) => s.loaded);
  const setView = useTaskboardStore((s) => s.setView);
  const [newOpen, setNewOpen] = useState(false);

  const deleted = useMemo(
    () =>
      tasks
        .filter((task) => task.deletedAt != null)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
    [tasks],
  );

  const onRestore = (id: string) => {
    void wsClient.request({ type: 'taskboard.restore', id }).catch((err) => {
      console.warn('[taskboard] 恢复失败:', err);
      toastError(t('toast.restoreFailed'));
    });
  };

  return (
    <div
      className="grid h-full min-h-0 w-full overflow-hidden bg-canvas"
      style={{ gridTemplateColumns: '208px 1fr' }}
    >
      <TaskboardSidebar onNewTask={() => setNewOpen(true)} />

      <main className="flex min-w-0 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-7 py-6">
          <div className="mb-5 flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setView('main')}
              className="-ml-1.5 inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-xs text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
            >
              <ArrowLeft size={11} strokeWidth={1.6} />
              {t('recycle.back')}
            </button>
            <div className="flex items-baseline gap-3">
              <h1 className="font-serif text-xl tracking-tight text-text-primary">{t('sidebar.recycleBin')}</h1>
              <span className="text-xs tabular-nums text-text-tertiary">
                {t('recycle.count', { count: deleted.length })}
              </span>
            </div>
            <span className="text-xs text-text-tertiary">{t('recycle.subtitle')}</span>
          </div>

          {!loaded ? (
            <div className="py-12 text-center text-sm text-text-tertiary">{t('common:loading')}</div>
          ) : deleted.length === 0 ? (
            <div className="py-12 text-center text-sm text-text-tertiary">
              {t('recycle.empty')}
            </div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {deleted.map((task) => (
                <DeletedRow key={task.id} task={task} onRestore={() => onRestore(task.id)} />
              ))}
            </ul>
          )}
        </div>
      </main>

      <NewTaskDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function DeletedRow({ task, onRestore }: { task: BoardTaskMeta; onRestore: () => void }) {
  const { t } = useTranslation('taskboard');
  const orig = task.preDeleteStatus ?? task.status;
  const actor = task.deletedBy ? t(`assignee.${task.deletedBy}`, { defaultValue: task.deletedBy }) : '—';
  return (
    <li className="flex items-center gap-3 rounded-md border border-border bg-elevated px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-text-primary">{task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-text-tertiary">
          <span className="inline-flex items-center gap-1">
            <span>{t('recycle.origStatus')}</span>
            <StatusBadge status={orig} size={12} showLabel />
          </span>
          {task.projectTag ? <span>{t('recycle.origProject', { tag: task.projectTag })}</span> : null}
          <span>
            {t('recycle.deletedBy', { actor })} ·{' '}
            {task.deletedAt ? formatTime(task.deletedAt) : '—'}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<RotateCcw size={14} strokeWidth={1.5} />}
        onClick={onRestore}
      >
        {t('recycle.restore')}
      </Button>
    </li>
  );
}
