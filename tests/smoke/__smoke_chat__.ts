/**
 * 深度烟雾测试：真实跑一次 chat.send，等待 chat.done
 * - 验证整个 Plan A+B+C 后端管线接通
 * - 验证 SDK resume：第二条消息能记得第一条
 * - 验证 sdkSessionId 写回 conversation
 *
 * 用法：tsx --tsconfig tsconfig.node.json electron/main/__smoke_chat__.ts
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import WebSocket from 'ws';
import { startWsServer, stopWsServer } from '../../electron/main/ws/server';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { createSubConversation, getConversation } from '../../electron/main/conversations/store';
import { newReqId } from '@shared/ids';
import type { ClientRequestPayload, ServerEvent } from '@shared/protocol';

const AGENT_ID = 'twin';
// 主对话已取消——开测时新建一条 sub 对话，id 运行时填入
let CONV_ID = '';
const TIMEOUT_MS = 60_000;

function send(ws: WebSocket, payload: ClientRequestPayload): { reqId: string } {
  const reqId = newReqId();
  ws.send(JSON.stringify({ ...payload, reqId }));
  return { reqId };
}

async function chatOnce(ws: WebSocket, text: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let assembled = '';
    let started = false;
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`chat timeout (${TIMEOUT_MS}ms) — assembled so far: ${JSON.stringify(assembled.slice(0, 200))}`));
    }, TIMEOUT_MS);
    function onMsg(raw: WebSocket.RawData) {
      let ev: ServerEvent;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      if (ev.type === 'chat.started') started = true;
      if (ev.type === 'chat.delta' && ev.conversationId === CONV_ID && ev.delta.textChunk) {
        assembled += ev.delta.textChunk;
      }
      if (ev.type === 'chat.done' && ev.conversationId === CONV_ID && started) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(assembled.trim());
      }
      if (ev.type === 'error') {
        clearTimeout(timer);
        ws.off('message', onMsg);
        reject(new Error(`server error: ${ev.code}: ${ev.message}`));
      }
    }
    ws.on('message', onMsg);
    send(ws, { type: 'chat.send', agentId: AGENT_ID, conversationId: CONV_ID, text });
  });
}

async function readSdkSessionId(): Promise<string | null> {
  try {
    const conv = await getConversation(AGENT_ID, CONV_ID);
    return conv.sdkSessionId;
  } catch {
    return null;
  }
}

async function main() {
  console.log('[chat-smoke] init agent + conversation...');
  await ensureDefaultAgent();
  const conv = await createSubConversation(AGENT_ID, '新对话');
  CONV_ID = conv.id;

  const port = await startWsServer();
  console.log(`[chat-smoke] ws on 127.0.0.1:${port}`);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'file://' });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  const sidBefore = await readSdkSessionId();
  console.log('[chat-smoke] sdkSessionId before:', sidBefore);

  console.log('[chat-smoke] turn 1: 一句话自我介绍');
  const r1 = await chatOnce(ws, '一句话自我介绍。');
  console.log('[chat-smoke] reply 1:', r1.slice(0, 200));

  const sidAfter1 = await readSdkSessionId();
  console.log('[chat-smoke] sdkSessionId after turn 1:', sidAfter1);
  if (!sidAfter1) {
    console.error('[chat-smoke] FAIL: sdkSessionId 没写回');
    process.exit(1);
  }

  console.log('[chat-smoke] turn 2: 你刚才说的最后一个字是什么？(测 resume)');
  const r2 = await chatOnce(ws, '你刚才说的最后一个字是什么？');
  console.log('[chat-smoke] reply 2:', r2.slice(0, 200));

  const sidAfter2 = await readSdkSessionId();
  console.log('[chat-smoke] sdkSessionId after turn 2:', sidAfter2);

  // resume 验证：reply 2 必须是包含上一句话最后字符的回应
  // 不严格断言（模型表达可能多样），打印到屏幕，由人看
  console.log('---');
  console.log('[chat-smoke] 人工验证 resume: reply 2 应当能引用 reply 1 的内容（至少不能说"没有上下文"或"不知道你上一句"）');
  console.log('---');

  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  stopWsServer();
  console.log('[chat-smoke] done');
  process.exit(0);
}

main().catch((e) => {
  console.error('[chat-smoke] FAILED:', e);
  stopWsServer();
  process.exit(1);
});
