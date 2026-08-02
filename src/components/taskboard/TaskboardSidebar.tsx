/**
 * 任务页左侧栏：分组导航。
 *
 * 结构：
 *   任务  [+]
 *   ─────
 *   全部 / 我的 / Oru 的 / 已完成    ← 固定 4 项
 *   ─────
 *   项目（动态 distinct projectTag）
 *   ─────
 *   回收站                          ← 沉到底
 *
 * 选中态：accent-soft 背景 + accent 文字。
 * 计数来自 selectSidebarCounts（含全部状态，已完成是跨归属的全量）。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  selectSidebarCounts,
  useTaskboardStore,
  type SidebarGroup,
} from '@/stores/taskboardStore';

export type TaskboardSidebarProps = {
  onNewTask: () => void;
};

export function TaskboardSidebar({ onNewTask }: TaskboardSidebarProps) {
  const { t } = useTranslation('taskboard');
  const tasks = useTaskboardStore((s) => s.tasks);
  const view = useTaskboardStore((s) => s.view);
  const sidebarGroup = useTaskboardStore((s) => s.sidebarGroup);
  const setSidebarGroup = useTaskboardStore((s) => s.setSidebarGroup);
  const setView = useTaskboardStore((s) => s.setView);

  const counts = useMemo(() => selectSidebarCounts({ tasks }), [tasks]);

  const isActive = (g: SidebarGroup): boolean => {
    if (view === 'recycle-bin') return false;
    if (g.kind === 'tag') {
      return sidebarGroup.kind === 'tag' && sidebarGroup.tag === g.tag;
    }
    return sidebarGroup.kind === g.kind;
  };

  const goto = (g: SidebarGroup) => {
    if (view !== 'main') setView('main');
    setSidebarGroup(g);
  };

  return (
    <aside className="flex h-full flex-col border-r border-border px-2.5 pb-3 pt-4">
      <div className="flex items-center justify-between px-1.5 pb-3">
        <h2 className="font-serif text-md tracking-tight text-text-primary">{t('sidebar.title')}</h2>
        <button
          type="button"
          onClick={onNewTask}
          title={t('sidebar.newTask')}
          aria-label={t('sidebar.newTask')}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
        >
          <Plus size={14} strokeWidth={1.6} />
        </button>
      </div>

      <nav className="flex flex-col">
        <NavRow
          label={t('group.all')}
          count={counts.all}
          active={isActive({ kind: 'all' })}
          onClick={() => goto({ kind: 'all' })}
        />
        <NavRow
          label={t('group.mine')}
          count={counts.mine}
          active={isActive({ kind: 'mine' })}
          onClick={() => goto({ kind: 'mine' })}
        />
        <NavRow
          label={t('group.oru')}
          count={counts.oru}
          active={isActive({ kind: 'oru' })}
          onClick={() => goto({ kind: 'oru' })}
        />
        <NavRow
          label={t('group.completed')}
          count={counts.completed}
          active={isActive({ kind: 'completed' })}
          onClick={() => goto({ kind: 'completed' })}
        />
      </nav>

      {counts.tags.length > 0 ? (
        <nav className="mt-1 flex flex-col">
          <div className="px-1.5 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-text-tertiary">
            {t('sidebar.projects')}
          </div>
          {counts.tags.map((tg) => (
            <NavRow
              key={tg.tag}
              icon="hash"
              label={tg.tag}
              count={tg.count}
              active={isActive({ kind: 'tag', tag: tg.tag })}
              onClick={() => goto({ kind: 'tag', tag: tg.tag })}
            />
          ))}
        </nav>
      ) : null}

      <div className="mt-auto pt-2">
        <NavRow
          label={t('sidebar.recycleBin')}
          count={counts.recycle}
          muted
          active={view === 'recycle-bin'}
          onClick={() => setView('recycle-bin')}
        />
      </div>
    </aside>
  );
}

type NavRowProps = {
  label: string;
  count: number;
  active?: boolean;
  muted?: boolean;
  icon?: 'hash';
  onClick: () => void;
};

function NavRow({ label, count, active, muted, icon, onClick }: NavRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm leading-5 transition-colors',
        active
          ? 'bg-accent-soft font-medium text-accent'
          : muted
            ? 'text-text-tertiary hover:bg-hover hover:text-text-secondary'
            : 'text-text-secondary hover:bg-hover hover:text-text-primary',
      )}
    >
      {icon === 'hash' ? (
        <span
          className={cn(
            'w-3 text-center text-xs',
            active ? 'text-accent' : 'text-text-tertiary/70',
          )}
        >
          #
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        className={cn(
          'shrink-0 text-[11px] tabular-nums',
          active ? 'text-accent' : 'text-text-tertiary',
        )}
      >
        {count > 0 ? count : ''}
      </span>
    </button>
  );
}
