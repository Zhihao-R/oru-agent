/**
 * 后台命令状态同步：挂载 + 断线重连时拉一次全量 + 订阅 bgCommand.changed 增量（同 useScheduledTaskSync 范式）。
 */
import { useEffect } from 'react';
import { wsClient } from '@/lib/ws';
import { onReconnect } from '@/lib/wsReconnect';
import { useBgCommandStore } from '@/stores/bgCommandStore';

export function useBgCommandSync(): void {
  useEffect(() => {
    const load = () => {
      void useBgCommandStore.getState().refresh();
    };
    load();
    // 断线期后台命令结束的 bgCommand.changed 会漏，重连不重拉则「运行中脉冲」永久挂着——靠重连重拉自愈
    const unsubReconnect = onReconnect(load);
    const unsub = wsClient.subscribe((ev) => {
      if (ev.type === 'bgCommand.changed') {
        useBgCommandStore.getState().applyChange(ev.command);
      }
    });
    return () => {
      unsubReconnect();
      unsub();
    };
  }, []);
}
