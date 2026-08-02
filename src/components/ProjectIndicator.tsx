/**
 * Notion 风工作区指示器：常驻显示"当前项目"，点击展开 popover 切换项目
 * - 浮层关闭：外部 mousedown / Esc / 选中某项目后
 * - 切项目不改变当前所在 tab（sidebarView 保持不动）
 * - 浮层底部"+ 新建项目"复用 AddProjectDialog
 * - 视觉对齐全应用：bg-elevated + shadow-pop（与 AgentChip / Dialog / StatusMenu 同款）
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useProjectStore } from '@/stores/projectStore';
import { AddProjectDialog } from './AddProjectDialog';

function initialOf(name: string | undefined): string {
  const c = name?.trim()[0];
  return c ? c.toUpperCase() : '?';
}

export function ProjectIndicator() {
  const { t } = useTranslation('app');
  const projects = useProjectStore((s) => s.projects);
  const activeId = useProjectStore((s) => s.activeProjectId);
  const switchProject = useProjectStore((s) => s.switchProject);

  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  // 外部 mousedown / Esc 关闭浮层（同一关闭语义，合并一个 effect）
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = projects.find((p) => p.id === activeId);

  return (
    <div ref={rootRef} className="relative border-b border-border px-2 pb-2 pt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
          open ? 'bg-hover' : 'hover:bg-hover',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
      >
        <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded bg-accent-soft text-xs font-semibold text-accent">
          {initialOf(active?.name)}
        </div>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {active?.name ?? t('noProjectSelected')}
        </span>
        <ChevronDown
          size={10}
          strokeWidth={2}
          className={cn(
            'shrink-0 text-text-tertiary transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-2 right-2 top-full z-20 mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-elevated p-1 shadow-pop"
        >
          {projects.length === 0 ? (
            <div className="px-2 py-2 text-xs text-text-tertiary">
              {t('projectListEmpty')}
            </div>
          ) : (
            projects.map((p) => {
              const isActive = p.id === activeId;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    void switchProject(p.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    isActive ? 'bg-accent-soft' : 'hover:bg-hover',
                  )}
                >
                  <div
                    className={cn(
                      'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-xs font-semibold',
                      isActive
                        ? 'bg-accent-soft text-accent'
                        : 'bg-sunken text-text-secondary',
                    )}
                  >
                    {initialOf(p.name)}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-text-primary">{p.name}</span>
                </button>
              );
            })
          )}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setAddOpen(true);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-base text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
          >
            <Plus size={12} strokeWidth={1.5} />
            <span>{t('newProject')}</span>
          </button>
        </div>
      ) : null}

      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
