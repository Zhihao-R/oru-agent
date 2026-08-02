/**
 * Anthropic 后端 wire 健壮性回归：空 text block / 空 tool_result content 不进请求体
 *
 * 源头：Kimi（kimi-coding，严格 anthropic 兼容端点）对含空文本块的请求 400
 * 「text content is empty」，dream 类多轮工具调用全灭——
 *   ① 模型开了 text block 但零 delta（守则让模型调工具时别说话，先开块再空关），
 *      content_block_stop 时不能把这个空块推进下一轮 assistant message；
 *   ② 工具返回空串 text，tool_result content 不能原样放空串。
 * 形态照 toolResultImageWire.test.ts 的 fake Anthropic server。
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

async function startFakeAnthropic(rounds: Array<Array<{ name: string; data: object }>>): Promise<{
  baseURL: string;
  receivedBodies: Array<{ messages: Array<{ role: string; content: unknown }> }>;
  close: () => Promise<void>;
}> {
  const receivedBodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
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

/** 第一轮：模型先开一个 text block 但零 delta 就关掉，再接一个 tool_use ——空块场景 */
function anthEmptyTextThenToolRound(): Array<{ name: string; data: object }> {
  return [
    { name: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'k3', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'noop_tool', input: {} } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } } },
    { name: 'message_stop', data: { type: 'message_stop' } },
  ];
}

function anthEndRound(): Array<{ name: string; data: object }> {
  return [
    { name: 'message_start', data: { type: 'message_start', message: { id: 'm2', model: 'k3', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 1 } } } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } } },
    { name: 'message_stop', data: { type: 'message_stop' } },
  ];
}

/** 返回空串 text 的工具——tool_result content 空串场景 */
function emptyTextTool(): AgentTool {
  return {
    name: 'noop_tool',
    description: '什么都不返回',
    inputSchema: { type: 'object' as const, properties: {} },
    mutatesEnvironment: false,
    async execute() {
      return { text: '' };
    },
  } satisfies AgentTool;
}

const baseInput = (): ConversationInput => ({
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
});

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe('Anthropic wire：空文本块不进请求体（Kimi 严格端点兼容）', () => {
  it('空 text block 不进下一轮 assistant message；空 tool_result content 用占位文本', async () => {
    const fake = await startFakeAnthropic([anthEmptyTextThenToolRound(), anthEndRound()]);
    cleanup = fake.close;
    const backend = new AnthropicBackend({
      apiKey: 'k',
      defaultModel: 'k3',
      baseURL: fake.baseURL,
    });
    backend.registerTool(emptyTextTool());
    const handle = backend.runConversation(baseInput());
    for await (const ev of handle.events) void ev;

    expect(fake.receivedBodies.length).toBe(2);
    const second = fake.receivedBodies[1];
    const assistant = second.messages.find((m) => m.role === 'assistant');
    // ① assistant message 里不得有空 text block（只剩 tool_use）
    const blocks = assistant?.content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === 'text' && b.text === '')).toBe(false);
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
    // ② tool_result content 不得为空串
    const userTurn = second.messages[second.messages.length - 1];
    const toolResults = (userTurn.content as Array<{ type: string; content?: unknown }>).filter(
      (b) => b.type === 'tool_result',
    );
    expect(toolResults.length).toBe(1);
    expect(toolResults[0].content).not.toBe('');
    expect(typeof toolResults[0].content).toBe('string');
  });
});
