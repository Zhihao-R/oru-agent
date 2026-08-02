/**
 * OpenAICompatibleBackend 内部协议正确性 smoke
 *
 * 不打真 API；本地 fake server 拦截 /v1/chat/completions 验证：
 * - SSE 流解析（content delta、tool_calls delta、finish_reason）
 * - 多 tool_calls 并发等齐再发下一轮（Promise.all）
 * - 工具抛错时 tool 回执 is_error 含错误描述（不漏 tool_call_id）
 * - history 通过 historyAdapter('openai-fc') 翻译成 messages
 * - response_format: json_schema 优先 + 回退到 prompt 注入
 */
import './__smoke_isolate__';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { AgentTool } from '@shared/agent/backend';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

type ChunkSSE = Array<string>; // 每条要写到响应的 SSE event 已格式化字符串

type RoundConfig = {
  /** 流式 SSE chunks（按顺序写出，每个含 \n\n 分隔） */
  sseChunks: ChunkSSE;
};

type NonStreamConfig = {
  status?: number;
  /** json 字符串 */
  body: string;
};

async function startFakeServer(opts: {
  streamRounds?: RoundConfig[];
  nonStreamRounds?: NonStreamConfig[];
}): Promise<{
  baseURL: string;
  receivedBodies: unknown[];
  close: () => Promise<void>;
}> {
  const receivedBodies: unknown[] = [];
  let streamIdx = 0;
  let nonStreamIdx = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      receivedBodies.push(body);

      if (body.stream === true) {
        const r = opts.streamRounds?.[streamIdx];
        streamIdx += 1;
        if (!r) {
          res.statusCode = 500;
          res.end('no stream rounds');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        for (const c of r.sseChunks) res.write(c);
        res.end();
        return;
      }
      const nr = opts.nonStreamRounds?.[nonStreamIdx];
      nonStreamIdx += 1;
      if (!nr) {
        res.statusCode = 500;
        res.end('no non-stream rounds');
        return;
      }
      res.statusCode = nr.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(nr.body);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseURL = `http://127.0.0.1:${addr.port}/v1`;
  const close = (): Promise<void> => new Promise((r) => server.close(() => r()));
  return { baseURL, receivedBodies, close };
}

function sse(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
const DONE = `data: [DONE]\n\n`;

function endTurnRound(text: string): RoundConfig {
  return {
    sseChunks: [
      sse({ choices: [{ delta: { content: text }, finish_reason: null }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      DONE,
    ],
  };
}

function singleToolCallRound(opts: {
  text?: string;
  callId: string;
  toolName: string;
  argsJson: string;
}): RoundConfig {
  // 把 argsJson 拆成两段模拟流式 partial
  const half = Math.floor(opts.argsJson.length / 2);
  const part1 = opts.argsJson.slice(0, half);
  const part2 = opts.argsJson.slice(half);
  const chunks: string[] = [];
  if (opts.text) {
    chunks.push(sse({ choices: [{ delta: { content: opts.text }, finish_reason: null }] }));
  }
  chunks.push(
    sse({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: opts.callId,
                type: 'function',
                function: { name: opts.toolName, arguments: part1 },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  );
  chunks.push(
    sse({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: part2 },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  );
  chunks.push(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  chunks.push(DONE);
  return { sseChunks: chunks };
}

function multiToolCallRound(calls: Array<{ callId: string; toolName: string; argsJson: string }>): RoundConfig {
  const chunks: string[] = [];
  // 每个 tool_call 一条 delta（一次性给完 args）
  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    chunks.push(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: i,
                  id: c.callId,
                  type: 'function',
                  function: { name: c.toolName, arguments: c.argsJson },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  }
  chunks.push(sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  chunks.push(DONE);
  return { sseChunks: chunks };
}

function recordingTool(
  name: string,
  returnText: string,
  throwErr?: Error,
): { tool: AgentTool; calls: unknown[] } {
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

async function consumeEvents(handle: { events: AsyncIterable<unknown> }): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const ev of handle.events) collected.push(ev);
  return collected;
}

async function caseEndTurnSimple(): Promise<void> {
  const fake = await startFakeServer({ streamRounds: [endTurnRound('Hello')] });
  try {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-fake',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
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
    const result = events.find((e) => (e as { type: string }).type === 'result') as
      | { type: 'result'; resultText: string }
      | undefined;
    assert(result?.resultText === 'Hello', 'simple: result.resultText === Hello', result?.resultText);
    const body = fake.receivedBodies[0] as { messages: Array<{ role: string }> };
    assert(body.messages.length === 1 && body.messages[0].role === 'user', 'simple: 1 条 user 消息', JSON.stringify(body.messages));
  } finally {
    await fake.close();
  }
}

async function caseSystemAndHistoryReplay(): Promise<void> {
  const fake = await startFakeServer({ streamRounds: [endTurnRound('OK')] });
  try {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-fake',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
    });
    await consumeEvents(
      backend.runConversation({
        agentId: 'smoke-agent',
        conversationId: 'cnv',
        userMessage: 'second',
        systemContext: 'You are Twin.',
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
            backendType: 'openai-compatible',
            toolProtocol: 'openai-fc',
          },
          {
            id: 'u2',
            conversationId: 'cnv',
            role: 'user',
            text: 'second',
            toolCalls: [],
            createdAt: 3,
            done: true,
          },
        ],
        cwd: process.cwd(),
        abortController: new AbortController(),
      }),
    );
    const body = fake.receivedBodies[0] as { messages: Array<{ role: string; content: unknown }> };
    assert(body.messages.length === 4, 'history+system: 4 条 messages', `len=${body.messages.length}`);
    if (body.messages.length === 4) {
      assert(body.messages[0].role === 'system' && body.messages[0].content === 'You are Twin.', 'system 在 messages[0]', JSON.stringify(body.messages[0]));
      assert(body.messages[1].role === 'user', 'messages[1] = user', body.messages[1].role);
      assert(body.messages[2].role === 'assistant', 'messages[2] = assistant', body.messages[2].role);
      assert(body.messages[3].role === 'user', 'messages[3] = user', body.messages[3].role);
    }
  } finally {
    await fake.close();
  }
}

async function caseMultiToolCallsRoundTrip(): Promise<void> {
  const a = recordingTool('tool_a', 'a-result');
  const b = recordingTool('tool_b', 'b-result');
  const fake = await startFakeServer({
    streamRounds: [
      multiToolCallRound([
        { callId: 'call_a', toolName: 'tool_a', argsJson: '{"x":"1"}' },
        { callId: 'call_b', toolName: 'tool_b', argsJson: '{"x":"2"}' },
      ]),
      endTurnRound('Done'),
    ],
  });
  try {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-fake',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
    });
    backend.registerTool(a.tool);
    backend.registerTool(b.tool);
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
    const tu = events.filter((e) => (e as { type: string }).type === 'tool_use');
    assert(tu.length === 2, '多 tool: 2 个 tool_use 事件', `len=${tu.length}`);
    const tr = events.filter((e) => (e as { type: string }).type === 'tool_result');
    assert(tr.length === 2, '多 tool: 2 个 tool_result 事件', `len=${tr.length}`);
    assert(a.calls.length === 1 && b.calls.length === 1, '两个 tool 各被调用 1 次', `a=${a.calls.length} b=${b.calls.length}`);

    // 第二轮 body 必须含 2 条 role:'tool' 消息
    assert(fake.receivedBodies.length === 2, '总共发了 2 次请求', String(fake.receivedBodies.length));
    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; tool_call_id?: string }> };
    const toolMsgs = body2.messages.filter((m) => m.role === 'tool');
    assert(toolMsgs.length === 2, '第二轮含 2 条 role:tool 消息', `len=${toolMsgs.length}`);
    const ids = toolMsgs.map((m) => m.tool_call_id).sort();
    assert(JSON.stringify(ids) === JSON.stringify(['call_a', 'call_b']), 'tool_call_id 全部回执', ids.join(','));

    const result = events.find((e) => (e as { type: string }).type === 'result') as
      | { type: 'result'; resultText: string }
      | undefined;
    assert(result?.resultText === 'Done', '最终 result === Done', result?.resultText);
  } finally {
    await fake.close();
  }
}

async function caseToolThrows(): Promise<void> {
  const a = recordingTool('boom', '', new Error('simulated'));
  const fake = await startFakeServer({
    streamRounds: [
      singleToolCallRound({ callId: 'call_x', toolName: 'boom', argsJson: '{}' }),
      endTurnRound('已处理错误'),
    ],
  });
  try {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-fake',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
    });
    backend.registerTool(a.tool);
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
    assert((tr?.content ?? '').includes('simulated'), 'tool_result.content 含错误描述', tr?.content);

    // 第二轮请求 body 仍含 role:tool 回执（不漏 tool_call_id）
    assert(fake.receivedBodies.length === 2, '抛错后仍走 round-trip 第二轮', String(fake.receivedBodies.length));
    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; tool_call_id?: string; content?: string }> };
    const errMsg = body2.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_x');
    assert(!!errMsg, '抛错也补上了 role:tool 回执', JSON.stringify(errMsg));
    assert((errMsg?.content ?? '').includes('error'), 'tool 回执 content 含 error 标记', errMsg?.content);
  } finally {
    await fake.close();
  }
}

async function caseRunOneShotJsonSchema(): Promise<void> {
  const fake = await startFakeServer({
    nonStreamRounds: [
      {
        body: JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: '{"ok":true,"value":42}' },
              finish_reason: 'stop',
            },
          ],
        }),
      },
    ],
  });
  try {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-fake',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
    });
    const { text } = await backend.runOneShot({
      prompt: 'give me json',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      model: 'gpt-5',
    });
    assert(text.includes('ok') && text.includes('true'), 'runOneShot returns JSON content', text);
    const body = fake.receivedBodies[0] as { response_format?: { type?: string } };
    assert(body.response_format?.type === 'json_schema', 'runOneShot 用 response_format: json_schema', JSON.stringify(body.response_format));
    assert(fake.receivedBodies.length === 1, '非空正文：不发第二次请求', String(fake.receivedBodies.length));
  } finally {
    await fake.close();
  }
}

async function caseRunOneShotEmptyContentFallback(): Promise<void> {
  // 2026-06-11 真机故障的回归：模型（hy3-preview）对 json_schema 静默不兼容——
  // HTTP 200、只产 reasoning 不产正文 → 必须自动回退 prompt 注入重试，且两次 usage 合并不漏账
  const fake = await startFakeServer({
    nonStreamRounds: [
      {
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 9,
            completion_tokens_details: { reasoning_tokens: 9 },
          },
        }),
      },
      {
        body: JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: '{"operations":[]}' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 20 },
        }),
      },
    ],
  });
  try {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-fake',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
    });
    const { text, usage } = await backend.runOneShot({
      prompt: 'give me json',
      outputSchema: { type: 'object', properties: { operations: { type: 'array' } } },
    });
    assert(text === '{"operations":[]}', '空正文回退：返回第二次的正文', text);
    assert(fake.receivedBodies.length === 2, '空正文回退：发了两次请求', String(fake.receivedBodies.length));
    const b1 = fake.receivedBodies[0] as { response_format?: unknown };
    const b2 = fake.receivedBodies[1] as {
      response_format?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    assert(b1.response_format !== undefined, '第一次带 response_format');
    assert(b2.response_format === undefined, '第二次不带 response_format');
    const lastUser = [...b2.messages].reverse().find((m) => m.role === 'user');
    assert(
      typeof lastUser?.content === 'string' && lastUser.content.includes('合法 JSON'),
      '第二次末条 user 含 schema 注入文案',
      String(lastUser?.content).slice(-120),
    );
    assert(usage?.inputTokens === 220, '回退后 usage.inputTokens 两次合并（100+120）', String(usage?.inputTokens));
    assert(usage?.outputTokens === 29, '回退后 usage.outputTokens 两次合并（9+20）', String(usage?.outputTokens));
    assert(
      usage?.extended?.reasoningTokens === 9,
      '回退后 reasoningTokens 合并保留首次的 9',
      JSON.stringify(usage?.extended),
    );
  } finally {
    await fake.close();
  }
}

async function caseRunOneShotBothEmpty(): Promise<void> {
  // 两次都空 → 返回空字符串不抛（上层 capture 按 failed: unparseable-output 处理）
  const emptyRound = {
    body: JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    }),
  };
  const fake = await startFakeServer({ nonStreamRounds: [emptyRound, emptyRound] });
  try {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-fake',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
    });
    const { text } = await backend.runOneShot({
      prompt: 'give me json',
      outputSchema: { type: 'object' },
    });
    assert(text === '', '两次都空：返回空字符串不抛', JSON.stringify(text));
    assert(fake.receivedBodies.length === 2, '两次都空：恰好两次请求（不无限重试）', String(fake.receivedBodies.length));
  } finally {
    await fake.close();
  }
}

async function main(): Promise<void> {
  console.log('=== openai_compatible_offline smoke ===');
  await caseEndTurnSimple();
  await caseSystemAndHistoryReplay();
  await caseMultiToolCallsRoundTrip();
  await caseToolThrows();
  await caseRunOneShotJsonSchema();
  await caseRunOneShotEmptyContentFallback();
  await caseRunOneShotBothEmpty();

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
