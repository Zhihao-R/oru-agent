/**
 * 列表区上方的元信息条：标题（当前分组）+ 计数 + 显示已完成 toggle。
 *
 * 排序/分组目前无菜单可操作——纯展示无信息量，已移除。
 * "项目筛选"和"归属筛选"在左侧 sidebar。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { cn } from '@/lib/cn';
import {
  selectHiddenCompletedCount,
  useTaskboardStore,
  type SidebarGroup,
} from '@/stores/taskboardStore';

function titleFor(group: SidebarGroup, t: TFunction): string {
  if (group.kind === 'tag') return t('group.tag', { tag: group.tag });
  return t(`group.${group.kind}`);
}

export function ListMeta({ visibleCount }: { visibleCount: number }) {
  const { t } = useTranslation('taskboard');
  const tasks = useTaskboardStore((s) => s.tasks);
  const view = useTaskboardStore((s) => s.view);
  const sidebarGroup = useTaskboardStore((s) => s.sidebarGroup);
  const filters = useTaskboardStore((s) => s.filters);
  const setFilters = useTaskboardStore((s) => s.setFilters);

  const hiddenCompleted = useMemo(
    () => selectHiddenCompletedCount({ tasks, view, sidebarGroup, filters }),
    [tasks, view, sidebarGroup, filters],
  );

  const title = titleFor(sidebarGroup, t);
  // "已完成"分组下不再显示"显示已完成"——它本身就是看全量
  const showCompletedToggle = sidebarGroup.kind !== 'completed';

  return (
    <div className="mb-5 flex flex-col gap-1.5">
      <div className="flex items-baseline gap-3">
        <h1 className="font-serif text-xl tracking-tight text-text-primary">{title}</h1>
        <span className="text-xs tabular-nums text-text-tertiary">
          {t('list.taskCount', { count: visibleCount })}
        </span>
      </div>
      {showCompletedToggle || hiddenCompleted > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-tertiary">
          {showCompletedToggle ? (
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={filters.showAllCompleted}
                onChange={(e) => setFilters({ showAllCompleted: e.target.checked })}
                className="h-3 w-3 cursor-pointer accent-accent"
              />
              <span>{t('list.showCompleted')}</span>
            </label>
          ) : null}
          {hiddenCompleted > 0 ? (
            <button
              type="button"
              onClick={() => setFilters({ showAllCompleted: true })}
              className={cn(
                'text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline',
              )}
            >
              {t('list.hiddenCompleted', { count: hiddenCompleted })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
