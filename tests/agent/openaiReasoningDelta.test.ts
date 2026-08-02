/**
 * openaiCompatible 解析 reasoning 通道（地基层，PM 拍板 2026-07-26：只解析不展示）。
 *
 * 背景：推理模型的输出分 reasoning（思考）/ content（正文）两通道。此前解析器只认
 * delta.content——reasoning-only 响应（hy3 前科）整段被扔，回合以「空正文成功」收尾、
 * 用户零感知。本期地基：识别 reasoning delta（两种字段形态 reasoning / reasoning_content），
 * 不产 assistant_text（不展示），在 result 事件带出 sawReasoning——供空产出报错文案区分
 * 「模型思考了但没给出回答」与「压根没响应」。
 *
 * fake OpenAI SSE server 手法复用 toolResultImageWire.test.ts。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConversationEvent, ConversationInput } from '@shared/agent/backend';
import { singleUserTurn } from '../../electron/main/agent/singleUserTurn';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';

function sse(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
const DONE = `data: [DONE]\n\n`;

let server: Server | null = null;

async function startFake(chunks: string[]): Promise<string> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        for (const c of chunks) res.write(c);
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server!.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}/v1`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function runAndCollect(baseURL: string): Promise<ConversationEvent[]> {
  const backend = new OpenAICompatibleBackend({
    apiKey: 'sk-test',
    defaultModel: 'r1-x',
    baseURL,
    providerType: 'openai',
  });
  const input: ConversationInput = {
    agentId: 'a1',
    conversationId: 'c1',
    history: singleUserTurn('c1', '讲个故事'),
    cwd: process.cwd(),
    abortController: new AbortController(),
  };
  const events: ConversationEvent[] = [];
  for await (const ev of backend.runConversation(input).events) events.push(ev);
  return events;
}

function resultOf(events: ConversationEvent[]) {
  return events.find((e) => e.type === 'result') as
    | { type: 'result'; resultText: string | null; sawReasoning?: boolean }
    | undefined;
}

describe('openaiCompatible reasoning 通道解析（地基）', () => {
  it('reasoning-only 流（delta.reasoning）→ 无 assistant_text、result.sawReasoning=true、正文空', async () => {
    const baseURL = await startFake([
      sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning: '让我想想，' }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: { reasoning: '用户要听故事……' }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      DONE,
    ]);
    const events = await runAndCollect(baseURL);

    expect(events.filter((e) => e.type === 'assistant_text')).toHaveLength(0); // 不展示：思考不产正文事件
    const result = resultOf(events);
    expect(result?.sawReasoning).toBe(true);
    expect(result?.resultText ?? '').toBe('');
  });

  it('reasoning_content 字段形态（DeepSeek 系）同样识别', async () => {
    const baseURL = await startFake([
      sse({ choices: [{ index: 0, delta: { reasoning_content: '思考中……' }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      DONE,
    ]);
    const events = await runAndCollect(baseURL);
    expect(resultOf(events)?.sawReasoning).toBe(true);
  });

  it('先思考后正文 → sawReasoning=true 且正文照常流出', async () => {
    const baseURL = await startFake([
      sse({ choices: [{ index: 0, delta: { reasoning: '想好了。' }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: { content: '从前有座山' }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      DONE,
    ]);
    const events = await runAndCollect(baseURL);

    const texts = events.filter((e) => e.type === 'assistant_text');
    expect(texts).toHaveLength(1);
    const result = resultOf(events);
    expect(result?.sawReasoning).toBe(true);
    expect(result?.resultText).toBe('从前有座山');
  });

  it('纯正文流（无 reasoning）→ sawReasoning 不为 true', async () => {
    const baseURL = await startFake([
      sse({ choices: [{ index: 0, delta: { content: '从前有座山' }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      DONE,
    ]);
    const events = await runAndCollect(baseURL);
    expect(resultOf(events)?.sawReasoning ?? false).toBe(false);
  });
});
