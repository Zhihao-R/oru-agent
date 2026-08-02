/**
 * D1 round-trip 内核抽取的特征化 + parity 安全网。
 *
 * 对「多轮工具调用 + steering drain + 边界通知 + 跨轮 usage」这一富场景，逐事件锁定两个 HTTP backend
 * （Anthropic / OpenAI 兼容）当前产出的 ConversationEvent 序列、result 累加 usage、以及 round-2 请求体里
 * steering/notice 的 wire 落位。重构前跑绿 = 锁定行为；抽 roundTrip.ts 内核后必须逐事件仍相等。
 *
 * 重点覆盖设计文档（docs/tech/2026-06-24-d1-*.md）点名的三处最易漂移：
 *  ① per-call llm_usage 事件形状（两 backend 不同：Anthropic 无 finishReason/extended；OpenAI 带）
 *  ② steering / notice 的 wire 落位（Anthropic 搭 tool_result 同一 user turn；OpenAI 另起 user 消息）
 *  ③ 跨轮 usage 累加（Anthropic input 与 cache 分计；OpenAI prompt_tokens 已含 cache）
 * 以及 tool_use 事件时机差异（Anthropic 流内即时 / OpenAI 流后批量）——表现为事件相对顺序不同。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentTool, ConversationInput } from '@shared/agent/backend';
import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';

// ─── 公共：录制工具 + 事件收集 + 富场景的 steering/notice 注入 ───

function recordingTool(name: string, returnText: string): { tool: AgentTool; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    tool: {
      name,
      description: `recording ${name}`,
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
      async execute(input) {
        calls.push(input);
        return { text: returnText };
      },
    },
  };
}

async function consume(handle: { events: AsyncIterable<unknown> }): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const ev of handle.events) out.push(ev as Record<string, unknown>);
  return out;
}

/** 富场景的 steering / notice 闭包：各只在第一次 drain 返回一条，之后返回空。 */
function makeDrains() {
  let steeringPending = true;
  let noticePending = true;
  return {
    drainSteering: async () => {
      if (!steeringPending) return [];
      steeringPending = false;
      return ['顺便把配色也调一下'];
    },
    drainBoundaryNotice: async () => {
      if (!noticePending) return [];
      noticePending = false;
      return ['[系统通知] 后台任务 X 已完成'];
    },
  };
}

const baseInput = (overrides: Partial<ConversationInput>): ConversationInput => ({
  agentId: 'a',
  conversationId: 'c',
  userMessage: '把首页标题改成蓝色',
  history: [
    { id: 'u1', conversationId: 'c', role: 'user', text: '把首页标题改成蓝色', toolCalls: [], createdAt: 1, done: true },
  ],
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
});

// 把事件归一成可断言形态（剥掉 structured 等不稳定字段）
function evType(e: Record<string, unknown>): string {
  return e.type as string;
}

// ─── Anthropic fake server ──────────────────────────────────────

function sseAnth(name: string, data: object): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startFakeAnthropic(rounds: Array<Array<{ name: string; data: object }>>) {
  const receivedBodies: unknown[] = [];
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

function anthToolRound() {
  return [
    { name: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 1 } } } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在改…' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'echo', input: {} } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":"hi"}' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } } },
    { name: 'message_stop', data: { type: 'message_stop' } },
  ];
}
function anthEndRound() {
  return [
    { name: 'message_start', data: { type: 'message_start', message: { id: 'm2', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: { input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '改好了' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } } },
    { name: 'message_stop', data: { type: 'message_stop' } },
  ];
}

// ─── OpenAI fake server ─────────────────────────────────────────

function sseOAI(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
const OAI_DONE = `data: [DONE]\n\n`;

async function startFakeOpenAI(rounds: string[][]) {
  const receivedBodies: unknown[] = [];
  let i = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      for (const c of rounds[i++]) res.write(c);
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${addr.port}/v1`,
    receivedBodies,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function oaiToolRound(): string[] {
  return [
    sseOAI({ model: 'gpt-5', choices: [{ delta: { content: '正在改…' }, finish_reason: null }] }),
    sseOAI({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tu1', function: { name: 'echo', arguments: '{"x":"hi"}' } }] }, finish_reason: null }] }),
    sseOAI({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    sseOAI({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 0 } } }),
    OAI_DONE,
  ];
}
function oaiEndRound(): string[] {
  return [
    sseOAI({ model: 'gpt-5', choices: [{ delta: { content: '改好了' }, finish_reason: null }] }),
    sseOAI({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sseOAI({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } }),
    OAI_DONE,
  ];
}

// ─────────────────────────────────────────────────────────────────

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

describe('D1 round-trip 特征化 / parity', () => {
  it('Anthropic：多轮工具+steering+notice+跨轮usage 的逐事件序列与 wire 落位', async () => {
    const fake = await startFakeAnthropic([anthToolRound(), anthEndRound()]);
    cleanup = fake.close;
    const { tool, calls } = recordingTool('echo', '工具结果A');
    const drains = makeDrains();
    const backend = new AnthropicBackend({ apiKey: 'sk', defaultModel: 'claude-sonnet-4-6', baseURL: fake.baseURL });
    backend.registerTool(tool);

    const events = await consume(backend.runConversation(baseInput(drains)));

    // ① 逐事件类型序列：Anthropic tool_use 流内即时（在 llm_usage 之前）
    expect(events.map(evType)).toEqual([
      'assistant_text', 'tool_use', 'llm_usage', 'tool_result', 'assistant_text', 'llm_usage', 'result',
    ]);
    expect(events[0]).toMatchObject({ type: 'assistant_text', text: '正在改…' });
    expect(events[1]).toMatchObject({ type: 'tool_use', id: 'tu1', name: 'echo', input: { x: 'hi' } });
    // per-call llm_usage 形状（无 finishReason / extended）
    expect(events[2]).toEqual({ type: 'llm_usage', inputTokens: 17, outputTokens: 3, cacheReadTokens: 5 });
    expect(events[3]).toMatchObject({ type: 'tool_result', toolUseId: 'tu1', isError: false, content: '工具结果A' });
    expect(events[5]).toEqual({ type: 'llm_usage', inputTokens: 20, outputTokens: 4, cacheReadTokens: 0 });
    // ③ 跨轮 usage 累加（input 与 cache 分计）
    expect(events[6]).toMatchObject({
      type: 'result',
      resultText: '改好了',
      isError: false,
      usage: { inputTokens: 30, outputTokens: 7, actualModel: 'claude-sonnet-4-6', extended: { cacheReadTokens: 5, cacheWriteTokens: 2 } },
    });
    expect(calls).toEqual([{ x: 'hi' }]);

    // ② steering/notice wire 落位：搭进 round-2 请求最后一条 user turn（tool_result + 文本块同 turn）
    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; content: unknown }> };
    const lastUser = body2.messages[body2.messages.length - 1];
    expect(lastUser.role).toBe('user');
    const blocks = lastUser.content as Array<{ type: string; text?: string; tool_use_id?: string }>;
    expect(blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === 'tu1')).toBe(true);
    expect(blocks.some((b) => b.type === 'text' && b.text?.includes('顺便把配色也调一下'))).toBe(true);
    expect(blocks.some((b) => b.type === 'text' && b.text?.includes('[系统通知] 后台任务 X 已完成'))).toBe(true);
  });

  it('OpenAI 兼容：多轮工具+steering+notice+跨轮usage 的逐事件序列与 wire 落位', async () => {
    const fake = await startFakeOpenAI([oaiToolRound(), oaiEndRound()]);
    cleanup = fake.close;
    const { tool, calls } = recordingTool('echo', '工具结果A');
    const drains = makeDrains();
    const backend = new OpenAICompatibleBackend({ apiKey: 'sk', defaultModel: 'gpt-5', baseURL: fake.baseURL, providerType: 'openai' });
    backend.registerTool(tool);

    const events = await consume(backend.runConversation(baseInput(drains)));

    // ① 逐事件类型序列：OpenAI tool_use 流后批量（在 llm_usage 之后）
    expect(events.map(evType)).toEqual([
      'assistant_text', 'llm_usage', 'tool_use', 'tool_result', 'assistant_text', 'llm_usage', 'result',
    ]);
    expect(events[0]).toMatchObject({ type: 'assistant_text', text: '正在改…' });
    // per-call llm_usage 形状（带 finishReason + extended.reasoningTokens）
    expect(events[1]).toEqual({ type: 'llm_usage', inputTokens: 17, outputTokens: 3, cacheReadTokens: 5, extended: { reasoningTokens: 0 }, finishReason: 'tool_calls' });
    expect(events[2]).toMatchObject({ type: 'tool_use', id: 'tu1', name: 'echo', input: { x: 'hi' } });
    expect(events[3]).toMatchObject({ type: 'tool_result', toolUseId: 'tu1', isError: false, content: '工具结果A' });
    expect(events[5]).toEqual({ type: 'llm_usage', inputTokens: 20, outputTokens: 4, cacheReadTokens: 0, extended: { reasoningTokens: 0 }, finishReason: 'stop' });
    // ③ 跨轮 usage 累加（prompt_tokens 已含 cache，故 input 累加值与 Anthropic 口径不同）
    expect(events[6]).toMatchObject({
      type: 'result',
      resultText: '改好了',
      isError: false,
      usage: { inputTokens: 37, outputTokens: 7, actualModel: 'gpt-5', extended: { cacheReadTokens: 5, reasoningTokens: 0 } },
    });
    expect(calls).toEqual([{ x: 'hi' }]);

    // ② steering/notice wire 落位：另起独立 user 消息（OpenAI 的 tool 消息是纯字符串，搭不了车）
    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; content: unknown }> };
    const userMsgs = body2.messages.filter((m) => m.role === 'user');
    expect(userMsgs.some((m) => typeof m.content === 'string' && (m.content as string).includes('顺便把配色也调一下'))).toBe(true);
    expect(userMsgs.some((m) => typeof m.content === 'string' && (m.content as string).includes('[系统通知] 后台任务 X 已完成'))).toBe(true);
    // tool 回执是独立 role:'tool' 消息（带 tool_call_id）
    expect(body2.messages.some((m) => m.role === 'tool')).toBe(true);
  });
});

// ─── 跨 backend 一致性（设计文档 §5 step 4）──────────────────────

/** 延迟解析的录制工具——用于验「并发执行但回执按声明顺序」。 */
function delayedTool(name: string, returnText: string, delayMs: number): AgentTool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      await new Promise((r) => setTimeout(r, delayMs));
      return { text: returnText };
    },
  };
}

describe('D1 跨 backend 一致性', () => {
  it('Anthropic：3 并发 tool_use → tool_result 顺序 == 声明顺序（不随完成先后）', async () => {
    // 三个工具声明序 A,B,C，但完成序 C,B,A（A 最慢）——回执必须仍 A,B,C
    const round1 = [
      { name: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'x', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } } },
      { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'A', name: 'toolA', input: {} } } },
      { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } },
      { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { name: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'B', name: 'toolB', input: {} } } },
      { name: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } },
      { name: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { name: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'C', name: 'toolC', input: {} } } },
      { name: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } } },
      { name: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
      { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } } },
      { name: 'message_stop', data: { type: 'message_stop' } },
    ];
    const fake = await startFakeAnthropic([round1, anthEndRound()]);
    cleanup = fake.close;
    const backend = new AnthropicBackend({ apiKey: 'sk', defaultModel: 'x', baseURL: fake.baseURL });
    backend.registerTool(delayedTool('toolA', 'RA', 30));
    backend.registerTool(delayedTool('toolB', 'RB', 10));
    backend.registerTool(delayedTool('toolC', 'RC', 0));

    const events = await consume(backend.runConversation(baseInput({})));
    const trIds = events.filter((e) => e.type === 'tool_result').map((e) => e.toolUseId);
    expect(trIds).toEqual(['A', 'B', 'C']);
    const trContent = events.filter((e) => e.type === 'tool_result').map((e) => e.content);
    expect(trContent).toEqual(['RA', 'RB', 'RC']);
  });

  it('OpenAI：3 并发 tool_calls → tool_result 顺序 == 声明顺序（不随完成先后）', async () => {
    const round1: string[] = [
      sseOAI({ model: 'x', choices: [{ delta: { tool_calls: [
        { index: 0, id: 'A', function: { name: 'toolA', arguments: '{}' } },
        { index: 1, id: 'B', function: { name: 'toolB', arguments: '{}' } },
        { index: 2, id: 'C', function: { name: 'toolC', arguments: '{}' } },
      ] }, finish_reason: null }] }),
      sseOAI({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      sseOAI({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      OAI_DONE,
    ];
    const fake = await startFakeOpenAI([round1, oaiEndRound()]);
    cleanup = fake.close;
    const backend = new OpenAICompatibleBackend({ apiKey: 'sk', defaultModel: 'x', baseURL: fake.baseURL, providerType: 'openai' });
    backend.registerTool(delayedTool('toolA', 'RA', 30));
    backend.registerTool(delayedTool('toolB', 'RB', 10));
    backend.registerTool(delayedTool('toolC', 'RC', 0));

    const events = await consume(backend.runConversation(baseInput({})));
    const trIds = events.filter((e) => e.type === 'tool_result').map((e) => e.toolUseId);
    expect(trIds).toEqual(['A', 'B', 'C']);
    const trContent = events.filter((e) => e.type === 'tool_result').map((e) => e.content);
    expect(trContent).toEqual(['RA', 'RB', 'RC']);
  });

  it('Anthropic：孤儿 tool_call（未声明工具）→ 回 isError 回执、round-trip 照常走完', async () => {
    const round1 = [
      { name: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'x', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } } },
      { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'g1', name: 'ghostTool', input: {} } } },
      { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } },
      { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } } },
      { name: 'message_stop', data: { type: 'message_stop' } },
    ];
    const fake = await startFakeAnthropic([round1, anthEndRound()]);
    cleanup = fake.close;
    const backend = new AnthropicBackend({ apiKey: 'sk', defaultModel: 'x', baseURL: fake.baseURL });
    // 不注册 ghostTool

    const events = await consume(backend.runConversation(baseInput({})));
    const tr = events.find((e) => e.type === 'tool_result') as Record<string, unknown> | undefined;
    expect(tr?.isError).toBe(true);
    expect(tr?.content).toContain('不在本回合可用工具集内');
    // round-trip 照常走完：第二轮发生 + result 收尾
    expect(fake.receivedBodies.length).toBe(2);
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });

  it('OpenAI：孤儿 tool_call（未声明工具）→ 回 isError 回执、round-trip 照常走完', async () => {
    const round1: string[] = [
      sseOAI({ model: 'x', choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', function: { name: 'ghostTool', arguments: '{}' } }] }, finish_reason: null }] }),
      sseOAI({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      sseOAI({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      OAI_DONE,
    ];
    const fake = await startFakeOpenAI([round1, oaiEndRound()]);
    cleanup = fake.close;
    const backend = new OpenAICompatibleBackend({ apiKey: 'sk', defaultModel: 'x', baseURL: fake.baseURL, providerType: 'openai' });
    // 不注册 ghostTool

    const events = await consume(backend.runConversation(baseInput({})));
    const tr = events.find((e) => e.type === 'tool_result') as Record<string, unknown> | undefined;
    expect(tr?.isError).toBe(true);
    expect(tr?.content).toContain('不在本回合可用工具集内');
    expect(fake.receivedBodies.length).toBe(2);
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });
});
