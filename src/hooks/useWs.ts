import { useEffect, useState } from 'react';
import { wsClient, type WsStatus } from '@/lib/ws';

export function useWs(): { client: typeof wsClient; status: WsStatus; ready: boolean } {
  const [status, setStatus] = useState<WsStatus>(wsClient.status());

  useEffect(() => {
    // 订阅连接状态变更（D4）：取代原 300ms 轮询——事件驱动、零空转、状态变更即时反映。
    // 订阅后再对齐一次当前值，规避「订阅注册前刚发生过变更」的窗口。
    const unsubscribe = wsClient.onStatus((s) => setStatus(s));
    setStatus((prev) => (prev === wsClient.status() ? prev : wsClient.status()));
    return unsubscribe;
  }, []);

  return { client: wsClient, status, ready: status === 'open' };
}
