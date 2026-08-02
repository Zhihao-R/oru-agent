/**
 * 后端烟雾测试 — 不启 Electron，直接起 WS server，模拟 client 走基本流程
 *
 * 用法：npm run smoke:backend
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import WebSocket from 'ws';
import { startWsServer, stopWsServer } from './ws/server';
import { newReqId } from '@shared/ids';
import type { ClientRequestPayload, ServerEvent } from '@shared/protocol';

async function send(
  ws: WebSocket,
  payload: ClientRequestPayload,
  expected: string,
  timeoutMs = 3000,
): Promise<ServerEvent> {
  const reqId = newReqId();
  return new Promise<ServerEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for ${expected} (reqId=${reqId})`));
    }, timeoutMs);

    function onMsg(raw: WebSocket.RawData) {
      try {
        const ev = JSON.parse(raw.toString()) as ServerEvent;
        if (ev.reqId === reqId) {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(ev);
        }
      } catch {
        // 忽略，可能是 broadcast
      }
    }
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ ...payload, reqId }));
  });
}

async function main() {
  console.log('[smoke] starting ws server...');
  // 启动前需要先 ensure agent / conversation 与 production 一致
  // 主对话已取消——smoke 自建一条 sub 对话来跑协议形态
  const { ensureDefaultAgent } = await import('./agent/store/agents');
  const { createSubConversation } = await import('./conversations/store');
  const agent = await ensureDefaultAgent();
  const smokeConv = await createSubConversation(agent.id, '新对话');
  console.log('[smoke] default agent ensured:', agent.id, 'conv:', smokeConv.id);

  const port = await startWsServer();
  console.log(`[smoke] ws server listening on 127.0.0.1:${port}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  console.log('[smoke] client connected');

  const projectsRes = await send(ws, { type: 'projects.list' }, 'projects.state');
  console.log('[smoke] projects.list →', JSON.stringify(projectsRes));

  const agentsRes = await send(ws, { type: 'agents.list' }, 'agents.state');
  console.log('[smoke] agents.list →', JSON.stringify(agentsRes));

  const convRes = await send(ws, { type: 'conv.list', agentId: 'twin' }, 'conv.state');
  console.log('[smoke] conv.list (twin) →', JSON.stringify(convRes));

  const authRes = await send(ws, { type: 'auth.status' }, 'auth.status');
  console.log('[smoke] auth.status →', JSON.stringify(authRes));

  const settingsRes = await send(ws, { type: 'settings.get' }, 'settings.state');
  console.log('[smoke] settings.get →', JSON.stringify(settingsRes));

  // 不真发 chat.send（避免在 smoke 里调 SDK），但验证协议形态可被服务端接收
  // 通过 chat.abort 测试新协议路由
  const abortRes = await send(
    ws,
    { type: 'chat.abort', agentId: 'twin', conversationId: smokeConv.id },
    'ack',
  );
  console.log('[smoke] chat.abort →', JSON.stringify(abortRes));

  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  stopWsServer();
  console.log('[smoke] done — all good');
  process.exit(0);
}

main().catch((e) => {
  console.error('[smoke] FAILED:', e);
  stopWsServer();
  process.exit(1);
});
