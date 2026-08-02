/**
 * 系统信号同步（S14）：挂载 + 断线重连时取初值 + 订阅 system.signals 广播（各源升起/消解都经它刷新）。
 */
import { useEffect } from 'react';
import type { SystemSignalsEvent } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { onReconnect } from '@/lib/wsReconnect';
import { useSystemSignalStore } from '@/stores/systemSignalStore';

export function useSystemSignalSync(): void {
  useEffect(() => {
    const load = async () => {
      try {
        const res = await wsClient.request<SystemSignalsEvent>({ type: 'system.signals.list' });
        if (res.type === 'system.signals') useSystemSignalStore.getState().sync(res.signals);
      } catch {
        // 取初值失败无妨——后续广播会补齐
      }
    };
    void load();
    // 断线期漏掉的信号升起/消解靠重连重拉对齐（否则消解事件丢了、告警残留）
    const unsubReconnect = onReconnect(() => void load());
    const unsub = wsClient.subscribe((ev) => {
      if (ev.type === 'system.signals') useSystemSignalStore.getState().sync(ev.signals);
    });
    return () => {
      unsubReconnect();
      unsub();
    };
  }, []);
}
