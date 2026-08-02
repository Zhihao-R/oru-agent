import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { route } from './router';
import type { ClientRequest, ServerEvent, ServerEventPayload } from '@shared/protocol';
import { isAllowedOrigin } from './originGuard';
import { unwatchAll } from '../fs/watcher';

let wss: WebSocketServer | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;
const clients = new Set<WebSocket>();

export type Broadcast = (event: ServerEventPayload) => void;
export type Reply = (reqId: string, event: ServerEventPayload) => void;

export async function startWsServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    httpServer = createServer();
    wss = new WebSocketServer({
      server: httpServer,
      // 浏览器/扩展恶意页能通过 ws:// 命中本机随机端口；
      // 必须握手期校 Origin 头白名单，仅放 Electron renderer 来源
      verifyClient: ({ origin }, cb) => {
        if (isAllowedOrigin(origin)) {
          cb(true);
        } else {
          console.warn('[oru.ws] 拒绝连接，origin =', origin);
          cb(false, 403, 'Forbidden origin');
        }
      },
    });

    wss.on('connection', (socket) => {
      clients.add(socket);
      console.log('[oru.ws] client connected, total =', clients.size);

      socket.on('message', async (raw) => {
        let req: ClientRequest;
        try {
          req = JSON.parse(raw.toString());
        } catch (err) {
          send(socket, { type: 'error', code: 'UNKNOWN', message: 'invalid json' });
          return;
        }

        const reply: Reply = (reqId, event) => send(socket, { ...event, reqId });
        try {
          await route(req, reply, broadcast);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send(socket, { type: 'error', code: 'UNKNOWN', message, reqId: req.reqId });
        }
      });

      socket.on('error', (err) => {
        // 发送撞上半关闭连接时 ws 把写错误 emit 成 'error'，无监听会 throw 成
        // uncaughtException；ws 自己会销毁 socket 并照常触发 close，这里只记日志
        console.warn('[oru.ws] socket error:', err.message);
      });

      socket.on('close', () => {
        clients.delete(socket);
        // 单活跃客户端：断开（reload/关窗）即清掉文件树全部哨兵，防 FSWatcher 句柄泄漏
        if (clients.size === 0) unwatchAll();
        console.log('[oru.ws] client disconnected, total =', clients.size);
      });
    });

    // ORU_WS_PORT：playtest 沙箱用固定端口让外部 launcher 可预测地连入；不设时 0=随机，与生产行为完全一致
    httpServer.listen(Number(process.env.ORU_WS_PORT) || 0, '127.0.0.1', () => {
      const address = httpServer!.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('cannot determine ws port'));
    });
    httpServer.on('error', reject);
  });
}

export function stopWsServer() {
  for (const c of clients) c.close();
  clients.clear();
  wss?.close();
  httpServer?.close();
  wss = null;
  httpServer = null;
}

function send(socket: WebSocket, event: ServerEvent) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

/** 当前连接的渲染进程数——rendererQuery 据此区分"无 UI"（空脏集语义）与"有 UI 待应答" */
export function clientCount(): number {
  return clients.size;
}

export const broadcast: Broadcast = (event) => {
  const payload = JSON.stringify(event);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  }
};
