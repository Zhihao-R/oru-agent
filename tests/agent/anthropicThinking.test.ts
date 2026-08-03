/**
 * Track B · Anthropic 直连 extended thinking 回归。
 *
 * 覆盖：
 * ① runOneShot：disableReasoning===false → 请求体带 thinking:{type:'enabled',budget_tokens} 且
 *    budget < max_tokens；关 / 缺省（coding plan、不发 thinking）→ 无该参数。
 * ② runConversation：thinking 开时请求带 thinking 参数；流里 thinking_delta 只走占位、**不吐
 *    assistant_text**（CoT 不外漏）；thinking 块带 signature 回传（工具 round-trip 续链必需）；
 *    最终 resultText 只含明说正文。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentTool, ConversationInput } from '@shared/agent/backend';
import { singleUserTurn } from '../../electron/main/agent/singleUserTurn';
import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';

function sseAnth(name: string, data: object): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 非流式 one-shot（messages.create JSON 应答）fake server */
async function startJsonServer(): Promise<{
  baseURL: string;
  receivedBodies: unknown[];
  close: () => Promise<void>;
}> {
  const receivedBodies: unknown[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/messages' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          model: 'm',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '嗨' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${addr.port}`,
    receivedBodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 流式（SSE）fake server——rounds 数组：每轮一个 SSE 事件序列 */
async function startSseServer(
  rounds: Array<Array<{ name: string; data: object }>>,
): Promise<{
  baseURL: string;
  receivedBodies: Array<{ messages?: Array<{ role: string; content: unknown }>; thinking?: unknown }>;
  close: () => Promise<void>;
}> {
  const receivedBodies: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
  let i = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/messages' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      const r = rounds[i++];
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      for (const ev of r) res.write(sseAnth(ev.name, ev.data));
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${addr.port}`,
    receivedBodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 第 1 轮：thinking 块（thinking_delta「CoT 机密」+ signature）+ 工具调用 */
function anthThinkingToolRound(): Array<{ name: string; data: object }> {
  return [
    { name: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'm', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先看看文件锁' } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '——机密推理内容' } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_abc123' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'noop_tool', input: {} } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } } },
    { name: 'message_stop', data: { type: 'message_stop' } },
  ];
}

/** 第 2 轮：最终纯文本（结果相当于工具执行后的收尾） */
function anthFinalTextRound(text: string): Array<{ name: string; data: object }> {
  return [
    { name: 'message_start', data: { type: 'message_start', message: { id: 'm2', model: 'm', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 1 } } } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } } },
    { name: 'message_stop', data: { type: 'message_stop' } },
  ];
}

function noopTool(): AgentTool {
  return {
    name: 'noop_tool',
    description: '什么都不返回',
    inputSchema: { type: 'object' as const, properties: {} },
    mutatesEnvironment: false,
    async execute() {
      return { text: 'ok' };
    },
  } satisfies AgentTool;
}

function baseInput(overrides: Partial<ConversationInput>): ConversationInput {
  return {
    agentId: 'a',
    conversationId: 'c',
    userMessage: '干活',
    history: singleUserTurn('c', '干活'),
    cwd: process.cwd(),
    abortController: new AbortController(),
    toolContext: {
      conversationId: 'c',
      agentId: 'a',
      ownerId: 'o',
      approvalMode: 'work',
      usage: 'twinMain',
      abortSignal: new AbortController().signal,
    },
    ...overrides,
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe('runOneShot 思考请求体', () => {
  it('思考开（disableReasoning:false）→ 请求体带 thinking、budget 显式 < max_tokens', async () => {
    const fake = await startJsonServer();
    cleanup = fake.close;
    const backend = new AnthropicBackend({
      apiKey: 'k',
      defaultModel: 'm',
      baseURL: fake.baseURL,
      maxOutputTokens: 8192,
    });
    await backend.runOneShot({ prompt: '命名', disableReasoning: false });
    const body = fake.receivedBodies[0] as { thinking?: { type: string; budget_tokens: number } };
    expect(body.thinking).toBeDefined();
    expect(body.thinking!.type).toBe('enabled');
    expect(body.thinking!.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(body.thinking!.budget_tokens).toBeLessThan(8192);
  });

  it('思考开但 max_tokens 太小塞不下预算 → 不发 thinking（防 400）', async () => {
    const fake = await startJsonServer();
    cleanup = fake.close;
    const backend = new AnthropicBackend({
      apiKey: 'k',
      defaultModel: 'm',
      baseURL: fake.baseURL,
      maxOutputTokens: 1500,
    });
    await backend.runOneShot({ prompt: '命名', disableReasoning: false });
    const body = fake.receivedBodies[0] as { thinking?: unknown };
    expect(body.thinking).toBeUndefined();
  });

  it('思考关（disableReasoning:true）→ 请求体无 thinking 参数（行为不变）', async () => {
    const fake = await startJsonServer();
    cleanup = fake.close;
    const backend = new AnthropicBackend({
      apiKey: 'k',
      defaultModel: 'm',
      baseURL: fake.baseURL,
    });
    await backend.runOneShot({ prompt: '命名', disableReasoning: true });
    const body = fake.receivedBodies[0] as { thinking?: unknown };
    expect(body.thinking).toBeUndefined();
  });

  it('缺省（undefined，coding plan 走这条路）→ 无 thinking 参数', async () => {
    const fake = await startJsonServer();
    cleanup = fake.close;
    const backend = new AnthropicBackend({
      apiKey: 'k',
      defaultModel: 'm',
      baseURL: fake.baseURL,
    });
    await backend.runOneShot({ prompt: '命名' });
    const body = fake.receivedBodies[0] as { thinking?: unknown };
    expect(body.thinking).toBeUndefined();
  });
});

describe('runConversation 思考：请求参数 + CoT 不外漏 + 工具 round-trip', () => {
  it('thinking 开时：请求带 thinking；流不吐 CoT；thinking 块带 signature 回传；resultText 只含明说正文', async () => {
    const fake = await startSseServer([anthThinkingToolRound(), anthFinalTextRound('文件是新的')]);
    cleanup = fake.close;
    const backend = new AnthropicBackend({ apiKey: 'k', defaultModel: 'm', baseURL: fake.baseURL });
    backend.registerTool(noopTool());

    const seenTexts: string[] = [];
    let resultText = '';
    for await (const ev of backend.runConversation(baseInput({ disableReasoning: false })).events) {
      if (ev.type === 'assistant_text') seenTexts.push(ev.text);
      if (ev.type === 'result') resultText = ev.resultText ?? '';
    }

    // ① 首轮请求带 thinking 参数
    expect(fake.receivedBodies[0]).toHaveProperty('thinking');
    const t0 = fake.receivedBodies[0].thinking as { type: string; budget_tokens: number };
    expect(t0.type).toBe('enabled');

    // ② CoT 不外漏：assistant_text 里绝不含 thinking_delta 的推理文本
    expect(seenTexts.every((t) => !t.includes('机密推理内容') && !t.includes('先看看文件锁'))).toBe(true);

    // ③ thinking 块带 signature 回传（第二轮 assistant message 含 thinking 块，续链合法）
    expect(fake.receivedBodies.length).toBe(2);
    const second = fake.receivedBodies[1];
    const assistant = second.messages!.find((m) => m.role === 'assistant');
    const blocks = assistant?.content as Array<{ type: string; thinking?: string; signature?: string }>;
    const thinkingBlock = blocks.find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.signature).toBe('sig_abc123');
    // 回传的 thinking 文本已 redact——CoT 不上第二轮的 wire
    expect(thinkingBlock!.thinking).not.toContain('机密推理内容');

    // ④ resultText 只含明说正文（不含 CoT）
    expect(resultText).toBe('文件是新的');
  });
});
