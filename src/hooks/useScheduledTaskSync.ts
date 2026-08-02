/**
 * 定时任务同步：挂载 + 断线重连时拉一次清单 + 订阅 scheduledTask.state（AI 工具/到点触发/他端改动都经它刷新）。
 */
import { useEffect } from 'react';
import { wsClient } from '@/lib/ws';
import { onReconnect } from '@/lib/wsReconnect';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';

export function useScheduledTaskSync(): void {
  useEffect(() => {
    const load = () => {
      void useScheduledTaskStore.getState().refresh();
      // 重载后恢复「执行中」指示（S18）：后端 inflight Map 是内存态，重连后据 RPC 补齐（应用重启则为空）。
      void useScheduledTaskStore.getState().refreshInflight();
    };
    load();
    const unsubReconnect = onReconnect(load); // 断线期漏掉的到点/完成增量靠重连重拉对齐
    const unsub = wsClient.subscribe((ev) => {
      if (ev.type === 'scheduledTask.state') {
        useScheduledTaskStore.getState().sync(ev);
      }
    });
    return () => {
      unsubReconnect();
      unsub();
    };
  }, []);
}
