/**
 * 任务主视图：三栏布局
 *   ┌──────────┬──────────────┬─────────────┐
 *   │ Sidebar  │ List         │ Detail      │
 *   │ 208px    │ flex 1       │ 408px (可关) │
 *   └──────────┴──────────────┴─────────────┘
 *
 * 详情面板是条件性显示：未选中任务时折叠（页面 2 栏），选中时显示。
 * 全局键盘：⌘N 新建任务，Esc 关详情面板。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  selectVisibleTasks,
  useTaskboardStore,
} from '@/stores/taskboardStore';
import { TaskboardSidebar } from './TaskboardSidebar';
import { ListMeta } from './ListMeta';
import { TaskList } from './TaskList';
import { NewTaskDialog } from './NewTaskDialog';
import { TaskDetailPanel } from './TaskDetailPanel';

export function TaskboardMainView() {
  const tasks = useTaskboardStore((s) => s.tasks);
  const view = useTaskboardStore((s) => s.view);
  const sidebarGroup = useTaskboardStore((s) => s.sidebarGroup);
  const selectedTaskId = useTaskboardStore((s) => s.selectedTaskId);
  const selectTask = useTaskboardStore((s) => s.selectTask);
  const [newOpen, setNewOpen] = useState(false);

  const visibleCount = useMemo(
    () => selectVisibleTasks({ tasks, view, sidebarGroup }).length,
    [tasks, view, sidebarGroup],
  );

  // ⌘N / Ctrl+N → 新建任务；Esc → 关详情面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        (target?.isContentEditable ?? false);
      if (e.key === 'n' && (e.metaKey || e.ctrlKey) && !inField) {
        e.preventDefault();
        setNewOpen(true);
      }
      if (e.key === 'Escape' && !inField && selectedTaskId) {
        e.preventDefault();
        selectTask(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedTaskId, selectTask]);

  return (
    <div className="grid h-full min-h-0 w-full overflow-hidden bg-canvas"
         style={{
           gridTemplateColumns: selectedTaskId ? '208px 1fr 408px' : '208px 1fr',
         }}>
      <TaskboardSidebar onNewTask={() => setNewOpen(true)} />

      <main className="flex min-w-0 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-7 py-6">
          <ListMeta visibleCount={visibleCount} />
          <TaskList />
        </div>
      </main>

      {selectedTaskId ? (
        <TaskDetailPanel
          key={selectedTaskId}
          taskId={selectedTaskId}
          onClose={() => selectTask(null)}
        />
      ) : null}

      <NewTaskDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}
