/**
 * 状态分组列表：4 个桶（待办 / 进行中 / 待验收 / 已完成）。
 *
 * - 空桶整组隐藏
 * - 已完成默认仅显当天（filters.showAllCompleted=false），但若 sidebarGroup='completed'
 *   则强制全量（绕过当天过滤）
 * - 排序：已完成按 completedAt desc；其他三桶按 updatedAt desc
 *   逻辑全部在 selectGroupByStatus 内
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectGroupByStatus,
  selectVisibleTasks,
  useTaskboardStore,
  type StatusGroup,
} from '@/stores/taskboardStore';
import { TaskRow } from './TaskRow';
import { statusLabel } from './statusLabel';

export function TaskList() {
  const { t } = useTranslation('taskboard');
  const tasks = useTaskboardStore((s) => s.tasks);
  const view = useTaskboardStore((s) => s.view);
  const sidebarGroup = useTaskboardStore((s) => s.sidebarGroup);
  const filters = useTaskboardStore((s) => s.filters);
  const loaded = useTaskboardStore((s) => s.loaded);

  const groups = useMemo(
    () => selectGroupByStatus({ tasks, view, sidebarGroup, filters }),
    [tasks, view, sidebarGroup, filters],
  );
  const visibleCount = useMemo(
    () => selectVisibleTasks({ tasks, view, sidebarGroup }).length,
    [tasks, view, sidebarGroup],
  );

  if (!loaded) {
    return <div className="px-2 py-12 text-center text-sm text-text-tertiary">{t('common:loading')}</div>;
  }
  if (visibleCount === 0) {
    return (
      <div className="px-2 py-12 text-center text-sm text-text-tertiary">
        {t('list.empty')}
      </div>
    );
  }

  const renderable = groups.filter((g) => g.tasks.length > 0);
  if (renderable.length === 0) {
    return (
      <div className="px-2 py-12 text-center text-sm text-text-tertiary">
        {t('list.filteredEmpty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {renderable.map((g) => (
        <Section key={g.status} group={g} />
      ))}
    </div>
  );
}

function Section({ group }: { group: StatusGroup }) {
  const { t } = useTranslation('taskboard');
  return (
    <section>
      <div className="mb-1 flex items-center gap-2 px-1.5 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          {statusLabel(group.status, t)}
        </span>
        <span className="text-[11px] tabular-nums text-text-tertiary/70">
          {group.tasks.length}
        </span>
      </div>
      <div className="flex flex-col">
        {group.tasks.map((task) => (
          <TaskRow key={task.id} task={task} />
        ))}
      </div>
    </section>
  );
}
