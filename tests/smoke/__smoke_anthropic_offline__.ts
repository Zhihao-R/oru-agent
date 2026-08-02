/**
 * AnthropicBackend 内部协议正确性 smoke
 *
 * 不打真 Anthropic API；通过 baseURL 指向本地 fake server 拦截请求验证：
 * - tool_use round-trip：第一轮 stop_reason=tool_use → backend 执行工具 → 第二轮 messages 含 tool_result block
 * - 工具抛错：tool_result 仍带 is_error=true 回执，不漏
 * - 流式事件 → ConversationEvent 翻译正确
 * - history 通过 historyAdapter 翻译后正确进入 messages
 */
import './__smoke_isolate__';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { AgentTool } from '@shared/agent/backend';
import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

/** 把 SSE 事件序列化为 wire format */
function sseEvent(eventName: string, data: object): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

type FakeRoundResponse = {
  /** 本轮包含的 SSE 事件序列 */
  events: Array<{ name: string; data: object }>;
};

/**
 * 启一个本地假的 Anthropic API server。每次请求 /v1/messages 时返回 rounds[currentRound] 的 SSE 流，
 * 同时把请求 body 记录下来供测试断言。
 */
async function startFakeAnthropic(rounds: FakeRoundResponse[]): Promise<{
  baseURL: string;
  receivedBodies: unknown[];
  close: () => Promise<void>;
}> {
  const receivedBodies: unknown[] = [];
  let roundIdx = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/messages' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      receivedBodies.push(body);

      const r = rounds[roundIdx];
      roundIdx += 1;
      if (!r) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'no more rounds defined' }));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      for (const ev of r.events) {
        res.write(sseEvent(ev.name, ev.data));
      }
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${addr.port}`;
  const close = (): Promise<void> => new Promise((r) => server.close(() => r()));
  return { baseURL, receivedBodies, close };
}

function recordingTool(name: string, returnText: string, throwErr?: Error): { tool: AgentTool; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    tool: {
      name,
      description: `recording ${name}`,
      inputSchema: {
        type: 'object',
        properties: { x: { type: 'string' } },
      },
      async execute(input) {
        calls.push(input);
        if (throwErr) throw throwErr;
        return { text: returnText };
      },
    },
  };
}

/** 构造一个完整轮次：单 text 输出，stop_reason=end_turn */
function endTurnRound(text: string): FakeRoundResponse {
  return {
    events: [
      { name: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } } },
      { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
      { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
      { name: 'message_stop', data: { type: 'message_stop' } },
    ],
  };
}

/** 构造一个工具调用轮次：assistant 输出 text + 一个 tool_use，stop_reason=tool_use */
function toolUseRound(opts: {
  text: string;
  toolUseId: string;
  toolName: string;
  toolInputJson: string;
}): FakeRoundResponse {
  return {
    events: [
      { name: 'message_start', data: { type: 'message_start', message: { id: 'msg_2', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } } },
      { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: opts.text } } },
      { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { name: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: opts.toolUseId, name: opts.toolName, input: {} } } },
      { name: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: opts.toolInputJson } } },
      { name: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } } },
      { name: 'message_stop', data: { type: 'message_stop' } },
    ],
  };
}

async function consumeEvents(handle: { events: AsyncIterable<unknown> }): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const ev of handle.events) collected.push(ev);
  return collected;
}

async function caseSimpleEndTurn(): Promise<void> {
  const fake = await startFakeAnthropic([endTurnRound('Hello')]);
  try {
    const backend = new AnthropicBackend({
      apiKey: 'sk-fake',
      defaultModel: 'claude-sonnet-4-6',
      baseURL: fake.baseURL,
    });
    const events = await consumeEvents(
      backend.runConversation({
        agentId: 'smoke-agent',
        conversationId: 'cnv',
        userMessage: 'hi',
        history: [
          {
            id: 'u1',
            conversationId: 'cnv',
            role: 'user',
            text: 'hi',
            toolCalls: [],
            createdAt: 1,
            done: true,
          },
        ],
        cwd: process.cwd(),
        abortController: new AbortController(),
      }),
    );
    const texts = events.filter((e) => (e as { type: string }).type === 'assistant_text');
    assert(texts.length > 0, 'simple: 至少 1 个 assistant_text 事件');
    const result = events.find((e) => (e as { type: string }).type === 'result') as
      | { type: 'result'; resultText: string }
      | undefined;
    assert(result?.resultText === 'Hello', 'simple: result.resultText === "Hello"', result?.resultText);
    assert(fake.receivedBodies.length === 1, 'simple: 只发 1 次请求', String(fake.receivedBodies.length));
    const body = fake.receivedBodies[0] as { messages: { role: string }[] };
    assert(body.messages.length === 1 && body.messages[0].role === 'user', 'simple: messages 含 1 条 user 消息', JSON.stringify(body.messages));
  } finally {
    await fake.close();
  }
}

async function caseToolUseRoundTrip(): Promise<void> {
  const { tool, calls } = recordingTool('echo', 'tool ran ok');
  const fake = await startFakeAnthropic([
    toolUseRound({ text: '我先调工具', toolUseId: 'tu_1', toolName: 'echo', toolInputJson: '{"x":"hi"}' }),
    endTurnRound('Done'),
  ]);
  try {
    const backend = new AnthropicBackend({
      apiKey: 'sk-fake',
      defaultModel: 'claude-sonnet-4-6',
      baseURL: fake.baseURL,
    });
    backend.registerTool(tool);
    const events = await consumeEvents(
      backend.runConversation({
        agentId: 'smoke-agent',
        conversationId: 'cnv',
        userMessage: 'echo something',
        history: [
          {
            id: 'u1',
            conversationId: 'cnv',
            role: 'user',
            text: 'echo something',
            toolCalls: [],
            createdAt: 1,
            done: true,
          },
        ],
        cwd: process.cwd(),
        abortController: new AbortController(),
        toolContext: {
          conversationId: 'cnv',
          agentId: 'agt_test',
          ownerId: 'local-user',
          usage: 'twinMain',
          approvalMode: 'work',
    abortSignal: new AbortController().signal,
        },
      }),
    );
    const tu = events.find((e) => (e as { type: string }).type === 'tool_use') as
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      | undefined;
    assert(tu?.name === 'echo', 'tool_use: name === echo', tu?.name);
    assert(tu?.input?.x === 'hi', 'tool_use: input 解析正确', JSON.stringify(tu?.input));
    assert(calls.length === 1, '工具被调用 1 次', String(calls.length));

    const tr = events.find((e) => (e as { type: string }).type === 'tool_result') as
      | { type: 'tool_result'; isError: boolean; content: string }
      | undefined;
    assert(tr?.content === 'tool ran ok', 'tool_result: 工具回执文本传递正确', tr?.content);
    assert(tr?.isError === false, 'tool_result: 非错误', String(tr?.isError));

    const result = events.find((e) => (e as { type: string }).type === 'result') as
      | { type: 'result'; resultText: string }
      | undefined;
    assert(result?.resultText === 'Done', '最终结果 === "Done"', result?.resultText);

    // 第二轮请求 body 必须含 tool_result block
    assert(fake.receivedBodies.length === 2, '总共发了 2 次请求（round-trip）', String(fake.receivedBodies.length));
    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; content: unknown[] }> };
    const lastMsg = body2.messages[body2.messages.length - 1];
    const hasToolResult =
      lastMsg.role === 'user' &&
      Array.isArray(lastMsg.content) &&
      lastMsg.content.some(
        (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
      );
    assert(hasToolResult, 'round-trip: 第二轮 messages 末尾含 tool_result block', JSON.stringify(lastMsg).slice(0, 300));
  } finally {
    await fake.close();
  }
}

async function caseToolThrows(): Promise<void> {
  const { tool } = recordingTool('boom', '', new Error('simulated failure'));
  const fake = await startFakeAnthropic([
    toolUseRound({ text: '调失败的工具', toolUseId: 'tu_x', toolName: 'boom', toolInputJson: '{}' }),
    endTurnRound('已处理错误'),
  ]);
  try {
    const backend = new AnthropicBackend({
      apiKey: 'sk-fake',
      defaultModel: 'claude-sonnet-4-6',
      baseURL: fake.baseURL,
    });
    backend.registerTool(tool);
    const events = await consumeEvents(
      backend.runConversation({
        agentId: 'smoke-agent',
        conversationId: 'cnv',
        userMessage: 'go',
        history: [
          {
            id: 'u1',
            conversationId: 'cnv',
            role: 'user',
            text: 'go',
            toolCalls: [],
            createdAt: 1,
            done: true,
          },
        ],
        cwd: process.cwd(),
        abortController: new AbortController(),
        toolContext: {
          conversationId: 'cnv',
          agentId: 'agt_test',
          ownerId: 'local-user',
          usage: 'twinMain',
          approvalMode: 'work',
    abortSignal: new AbortController().signal,
        },
      }),
    );
    const tr = events.find((e) => (e as { type: string }).type === 'tool_result') as
      | { type: 'tool_result'; isError: boolean; content: string }
      | undefined;
    assert(tr?.isError === true, 'tool 抛错：tool_result.isError === true', String(tr?.isError));
    assert((tr?.content ?? '').includes('simulated failure'), 'tool_result.content 含错误描述', tr?.content);

    // 第二轮请求 body 必须含一个 is_error=true 的 tool_result（不能漏回执）
    assert(fake.receivedBodies.length === 2, '抛错后仍走 round-trip 第二轮', String(fake.receivedBodies.length));
    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; content: unknown[] }> };
    const lastMsg = body2.messages[body2.messages.length - 1];
    const errBlock =
      Array.isArray(lastMsg.content) &&
      lastMsg.content.find(
        (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
      );
    const errBlockObj = errBlock as { is_error?: boolean } | false;
    assert(errBlockObj && errBlockObj.is_error === true, '抛错回执块 is_error=true', JSON.stringify(errBlockObj));
  } finally {
    await fake.close();
  }
}

async function caseHistoryReplay(): Promise<void> {
  const fake = await startFakeAnthropic([endTurnRound('OK')]);
  try {
    const backend = new AnthropicBackend({
      apiKey: 'sk-fake',
      defaultModel: 'claude-sonnet-4-6',
      baseURL: fake.baseURL,
    });
    await consumeEvents(
      backend.runConversation({
        agentId: 'smoke-agent',
        conversationId: 'cnv',
        userMessage: 'second turn',
        history: [
          {
            id: 'u1',
            conversationId: 'cnv',
            role: 'user',
            text: 'first',
            toolCalls: [],
            createdAt: 1,
            done: true,
          },
          {
            id: 'a1',
            conversationId: 'cnv',
            role: 'assistant',
            text: 'first reply',
            toolCalls: [],
            createdAt: 2,
            done: true,
            backendType: 'anthropic',
            toolProtocol: 'anthropic-native',
          },
          {
            id: 'u2',
            conversationId: 'cnv',
            role: 'user',
            text: 'second turn',
            toolCalls: [],
            createdAt: 3,
            done: true,
          },
        ],
        cwd: process.cwd(),
        abortController: new AbortController(),
      }),
    );
    const body = fake.receivedBodies[0] as { messages: Array<{ role: string }> };
    // 期望 messages 长度 3：user(first) / assistant(first reply) / user(second turn)
    assert(body.messages.length === 3, 'history 完整 replay 成 3 条 messages', `len=${body.messages.length}`);
    assert(body.messages[0].role === 'user', 'history[0] 是 user');
    assert(body.messages[1].role === 'assistant', 'history[1] 是 assistant');
    assert(body.messages[2].role === 'user', 'history[2] 是 user（本轮）');
  } finally {
    await fake.close();
  }
}

async function main(): Promise<void> {
  console.log('=== anthropic_offline smoke ===');
  await caseSimpleEndTurn();
  await caseToolUseRoundTrip();
  await caseToolThrows();
  await caseHistoryReplay();

  const failed = RESULTS.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${RESULTS.length}`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${RESULTS.length} cases`);
}

main().catch((e) => {
  console.error('smoke unhandled error:', e);
  process.exit(1);
});
