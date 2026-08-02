/**
 * WS 客户端单例
 * - 从 window.__ORU__.wsPort 读取端口
 * - 自动重连（指数退避，上限 5s）
 * - request() 按 reqId 匹配返回
 * - subscribe() 订阅所有 server 事件
 */

import type {
  ClientRequest,
  ClientRequestPayload,
  ServerEvent,
  ServerEventPayload,
} from '@shared/protocol';
import { newReqId } from '@shared/ids';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface OruWsClient {
  request<T extends ServerEventPayload = ServerEventPayload>(
    payload: ClientRequestPayload,
    timeoutMs?: number,
  ): Promise<T>;
  subscribe(handler: (event: ServerEvent) => void): () => void;
  /** 订阅连接状态变更（D4）：取代 useWs 的 300ms 轮询；重连时渲染层据此重灌服务端权威态。 */
  onStatus(handler: (status: WsStatus) => void): () => void;
  ready(): Promise<void>;
  status(): WsStatus;
}

type Pending = {
  resolve: (ev: ServerEventPayload) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const subscribers = new Set<(ev: ServerEvent) => void>();
const statusListeners = new Set<(s: WsStatus) => void>();
const pending = new Map<string, Pending>();
let socket: WebSocket | null = null;
let currentStatus: WsStatus = 'connecting';
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const readyWaiters: Array<() => void> = [];

function getPort(): number | null {
  if (typeof window === 'undefined') return null;
  const port = window.__ORU__?.wsPort;
  return typeof port === 'number' ? port : null;
}

/** 断线时立即失败所有在途请求并清空——否则白等到超时，且 reqId 复用会把新响应错配到旧 pending */
function failAllPending(reason: string): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

function setStatus(s: WsStatus): void {
  const changed = currentStatus !== s;
  currentStatus = s;
  if (s === 'open') {
    while (readyWaiters.length) readyWaiters.shift()?.();
  }
  // 通知状态订阅者（D4）。只在真变更时通知——避免重复 'open' 触发多余 resync。
  if (changed) {
    for (const h of statusListeners) {
      try {
        h(s);
      } catch {
        // 单个订阅者异常不影响其他
      }
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(5000, 250 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect(): void {
  const port = getPort();
  if (!port) {
    setStatus('closed');
    return;
  }
  setStatus('connecting');
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    setStatus('closed');
    scheduleReconnect();
    return;
  }
  socket.addEventListener('open', () => {
    reconnectAttempt = 0;
    setStatus('open');
  });
  socket.addEventListener('close', () => {
    setStatus('closed');
    socket = null;
    // 诊断类错误（传输层身份，非用户面文案）——不本地化；呈现由显示层负责
    // （调用方 wrapper 如 xFailedWith 已本地化，或未来照 L130 走 code 分流）。详见 glossary 判例。
    failAllPending('WebSocket 断开，请求中止');
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    // 关闭事件会触发重连
  });
  socket.addEventListener('message', (event) => {
    let parsed: ServerEvent;
    try {
      parsed = JSON.parse(typeof event.data === 'string' ? event.data : '') as ServerEvent;
    } catch {
      return;
    }
    if (parsed.reqId && pending.has(parsed.reqId)) {
      const p = pending.get(parsed.reqId)!;
      pending.delete(parsed.reqId);
      clearTimeout(p.timer);
      if (parsed.type === 'error') {
        // 把结构化 code 挂到 error 上，调用方可据此分流（如行内编辑区分"定位降级"vs"io 失败"），
        // 不必再去解析 message 前缀
        const err = new Error(`${parsed.code}: ${parsed.message}`) as Error & { code?: string };
        err.code = parsed.code;
        p.reject(err);
      } else {
        p.resolve(parsed);
      }
    }
    for (const h of subscribers) {
      try {
        h(parsed);
      } catch {
        // 单个订阅者异常不影响其他
      }
    }
  });
}

if (typeof window !== 'undefined') {
  // 立即连接
  connect();
}

export const wsClient: OruWsClient = {
  request<T extends ServerEventPayload = ServerEventPayload>(
    payload: ClientRequestPayload,
    timeoutMs = 30_000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const reqId = newReqId();
      const message: ClientRequest = { ...payload, reqId };
      const send = () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket 未连接')); // 诊断类，不本地化（同上）
          return;
        }
        socket.send(JSON.stringify(message));
      };
      const timer = setTimeout(() => {
        if (pending.has(reqId)) {
          pending.delete(reqId);
          reject(new Error(`请求超时: ${payload.type}`)); // 诊断类，不本地化（同上）
        }
      }, timeoutMs);
      pending.set(reqId, {
        resolve: (ev) => resolve(ev as T),
        reject,
        timer,
      });
      if (currentStatus === 'open') {
        send();
      } else {
        // 等就绪
        const waiter = () => {
          if (pending.has(reqId)) send();
        };
        readyWaiters.push(waiter);
      }
    });
  },
  subscribe(handler) {
    subscribers.add(handler);
    return () => {
      subscribers.delete(handler);
    };
  },
  onStatus(handler) {
    statusListeners.add(handler);
    return () => {
      statusListeners.delete(handler);
    };
  },
  ready() {
    if (currentStatus === 'open') return Promise.resolve();
    return new Promise<void>((resolve) => {
      readyWaiters.push(() => resolve());
    });
  },
  status() {
    return currentStatus;
  },
};
