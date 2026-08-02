/**
 * 进入任务页面时拉一次全量任务（含回收站）。
 *
 * - 初次拉：wsClient.request taskboard.list { includeDeleted: true }
 *   → store.hydrate；recycle-bin 视图和主视图共享 tasks 数组，按 view 派生过滤
 * - 退出页面不清空 tasks：用户在 nav 来回切不重拉
 * - broadcast 事件订阅在 App.tsx 全局 ws subscribe 里集中处理（与其他 chat.* / projects.* 一致）
 */
import { useEffect } from 'react';
import { wsClient } from '@/lib/ws';
import { onReconnect } from '@/lib/wsReconnect';
import { useTaskboardStore } from '@/stores/taskboardStore';

export function useTaskboardSync(): { loaded: boolean } {
  const loaded = useTaskboardStore((s) => s.loaded);
  const hydrate = useTaskboardStore((s) => s.hydrate);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await wsClient.request({
          type: 'taskboard.list',
          filters: { includeDeleted: true },
        });
        if (!cancelled && res.type === 'taskboard.list.result') {
          hydrate(res.tasks);
        }
      } catch (e) {
        // 不阻塞 UI；用户能看到空列表 + 重试入口（暂未实现）
        console.warn('[taskboard] 拉取失败:', e);
      }
    };
    void wsClient.ready().then(load);
    // 断线期漏掉的任务增删/状态变更靠重连重拉对齐
    const unsubReconnect = onReconnect(() => void load());
    return () => {
      cancelled = true;
      unsubReconnect();
    };
  }, [hydrate]);

  return { loaded };
}
