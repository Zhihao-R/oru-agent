/**
 * 任务主页面壳。按 view 切换到主视图 / 回收站。
 */
import { useTaskboardSync } from '@/hooks/useTaskboardSync';
import { useTaskboardStore } from '@/stores/taskboardStore';
import { TaskboardMainView } from './TaskboardMainView';
import { RecycleBinView } from './RecycleBinView';

export default function TaskboardPage() {
  useTaskboardSync();
  const view = useTaskboardStore((s) => s.view);
  return view === 'recycle-bin' ? <RecycleBinView /> : <TaskboardMainView />;
}
