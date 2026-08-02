/**
 * 智谱 prompt cache 链路 smoke（本地 fake server，不打真 API）
 *
 * 表驱动：每条 case 独立 fake server + 独立 backend 实例，验证：
 * 1. cached_tokens 从 SSE chunk → backend yield 'llm_usage' → result.usage.extended.cacheReadTokens
 * 2. sawUsage 重构：未见 usage chunk 时不输出 cacheReadTokens（区分"真 0"与"未返回"）
 * 3. 反向断言：request body 不含任何 cache 相关字段——我们没误加东西
 */
import './__smoke_isolate__';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';
import type { ConversationEvent } from '@shared/agent/backend';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function startFakeServer(rawResponse: string): Promise<{
  baseURL: string;
  receivedBody: () => unknown;
  close: () => Promise<void>;
}> {
  let received: unknown = null;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      received = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(rawResponse);
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
    receivedBody: () => received,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function sse(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
const DONE = `data: [DONE]\n\n`;

async function runOnce(rawResponse: string): Promise<{
  events: ConversationEvent[];
  body: unknown;
}> {
  const fake = await startFakeServer(rawResponse);
  try {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-fake',
      defaultModel: 'glm-4.6',
      baseURL: fake.baseURL,
      providerType: 'zhipu',
    });
    const handle = backend.runConversation({
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
    });
    const events: ConversationEvent[] = [];
    for await (const ev of handle.events) events.push(ev);
    return { events, body: fake.receivedBody() };
  } finally {
    await fake.close();
  }
}

function findResult(events: ConversationEvent[]): Extract<ConversationEvent, { type: 'result' }> | undefined {
  return events.find((e) => e.type === 'result') as
    | Extract<ConversationEvent, { type: 'result' }>
    | undefined;
}
function findUsage(events: ConversationEvent[]): Extract<ConversationEvent, { type: 'llm_usage' }> | undefined {
  return events.find((e) => e.type === 'llm_usage') as
    | Extract<ConversationEvent, { type: 'llm_usage' }>
    | undefined;
}

/** 反向断言：request body 不含任何 cache 控制字段（白名单方式更稳） */
function assertNoCacheFields(label: string, body: unknown): void {
  const known: ReadonlyArray<string> = [
    'model',
    'messages',
    'max_tokens',
    'stream',
    'stream_options',
    'tools',
    // 若未来引入合法字段（temperature / response_format 等）补到这里
  ];
  const keys = Object.keys(body as object);
  const extra = keys.filter((k) => !known.includes(k));
  assert(extra.length === 0, `${label}: request body 无未知字段（防止误加 cache 控制位）`, `extra=${JSON.stringify(extra)}`);
  // 二次保险：字符串扫描，挡住嵌进 messages / tools 里的 cache_*
  const s = JSON.stringify(body);
  const banned = ['cache_control', 'cache_key', 'prompt_cache_key', 'cacheControl', 'cache_options'];
  for (const w of banned) {
    assert(!s.includes(w), `${label}: 请求体不含 ${w}`, `body contains "${w}"`);
  }
}

// ─── case: happy_path ─────────────────────────────────────────
async function caseHappyPath(): Promise<void> {
  const resp = [
    sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sse({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }),
    DONE,
  ].join('');
  const { events, body } = await runOnce(resp);
  const result = findResult(events);
  const usage = findUsage(events);
  assert(
    (result?.usage?.extended as { cacheReadTokens?: number } | undefined)?.cacheReadTokens === 80,
    'happy_path: result.usage.extended.cacheReadTokens === 80',
    JSON.stringify(result?.usage),
  );
  assert(usage?.cacheReadTokens === 80, 'happy_path: llm_usage.cacheReadTokens === 80', JSON.stringify(usage));
  assertNoCacheFields('happy_path', body);
}

// ─── case: usage_chunk_missing ────────────────────────────────
async function caseUsageChunkMissing(): Promise<void> {
  const resp = [
    sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    DONE,
  ].join('');
  const { events } = await runOnce(resp);
  const result = findResult(events);
  const usage = findUsage(events);
  const ext = result?.usage?.extended as { cacheReadTokens?: number } | undefined;
  assert(
    ext === undefined || !('cacheReadTokens' in ext),
    'usage_chunk_missing: result.usage.extended 不含 cacheReadTokens（区别于"0"）',
    JSON.stringify(result?.usage),
  );
  assert(
    usage?.cacheReadTokens === undefined,
    'usage_chunk_missing: llm_usage.cacheReadTokens === undefined',
    JSON.stringify(usage),
  );
}

// ─── case: cached_tokens_zero（真未命中）─────────────────────
async function caseCachedTokensZero(): Promise<void> {
  const resp = [
    sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sse({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    }),
    DONE,
  ].join('');
  const { events } = await runOnce(resp);
  const result = findResult(events);
  const usage = findUsage(events);
  const ext = result?.usage?.extended as { cacheReadTokens?: number } | undefined;
  assert(
    ext?.cacheReadTokens === 0,
    'cached_tokens_zero: result.usage.extended.cacheReadTokens === 0（明确写出 0，区别于 undefined）',
    JSON.stringify(result?.usage),
  );
  assert(
    usage?.cacheReadTokens === 0,
    'cached_tokens_zero: llm_usage.cacheReadTokens === 0',
    JSON.stringify(usage),
  );
}

// ─── case: prompt_tokens_details_missing（usage 在但子字段缺）─
async function caseDetailsFieldMissing(): Promise<void> {
  const resp = [
    sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } }),
    DONE,
  ].join('');
  const { events } = await runOnce(resp);
  const result = findResult(events);
  const ext = result?.usage?.extended as { cacheReadTokens?: number } | undefined;
  assert(
    ext?.cacheReadTokens === 0,
    'details_field_missing: ?? 0 兜底 → cacheReadTokens === 0',
    JSON.stringify(result?.usage),
  );
}

// ─── case: prompt_tokens_details_null ─────────────────────────
async function caseDetailsNull(): Promise<void> {
  const resp = [
    sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sse({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: null },
    }),
    DONE,
  ].join('');
  const { events } = await runOnce(resp);
  const result = findResult(events);
  const ext = result?.usage?.extended as { cacheReadTokens?: number } | undefined;
  assert(
    ext?.cacheReadTokens === 0,
    'details_null: optional chain 兜底 → cacheReadTokens === 0',
    JSON.stringify(result?.usage),
  );
}

// ─── case: sse_broken_tail（末 chunk 被截断）───────────────────
async function caseSseBrokenTail(): Promise<void> {
  // 故意写一个不完整 SSE 块（没有 \n\n 终结）+ 真实流被强制 close
  const resp =
    sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }) +
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
    'data: {"choices":[],"usage":{"pr'; // 故意截断
  const { events } = await runOnce(resp);
  // 不崩、result 仍能 yield（finish_reason=stop 决定的，跟 usage 无关）
  const result = findResult(events);
  assert(result !== undefined, 'sse_broken_tail: 仍 yield result（不崩）');
  // cacheReadTokens 没拿到 usage 应当 undefined
  const ext = result?.usage?.extended as { cacheReadTokens?: number } | undefined;
  assert(
    ext === undefined || !('cacheReadTokens' in ext),
    'sse_broken_tail: cacheReadTokens 缺席（不是 0）',
    JSON.stringify(result?.usage),
  );
}

// ─── case: cached_tokens_string（类型异常 → typeof 守卫挡住，不污染累加器）─
async function caseCachedTokensString(): Promise<void> {
  const resp = [
    sse({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
    sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sse({
      // 带 model 字段 → buildUsage 不会因 inputTokens=0 && outputTokens=0 && !actualModel 而 return undefined
      model: 'glm-4.6',
      choices: [],
      usage: {
        // 整组都是字符串——某些 provider 历史上发过这种数据，typeof 守卫必须挡住
        prompt_tokens: '100' as unknown as number,
        completion_tokens: '5' as unknown as number,
        prompt_tokens_details: { cached_tokens: '80' as unknown as number },
      },
    }),
    DONE,
  ].join('');
  const { events } = await runOnce(resp);
  const result = findResult(events);
  const usage = findUsage(events);
  // 字符串被 typeof 守卫挡住 → 累加器保持数字 0，sawUsage 仍 true（因为 usage 对象在）
  assert(
    result?.usage?.inputTokens === undefined,
    'cached_tokens_string: inputTokens 字符串被守卫 → undefined（不污染）',
    JSON.stringify(result?.usage),
  );
  const ext = result?.usage?.extended as { cacheReadTokens?: unknown } | undefined;
  assert(
    ext?.cacheReadTokens === 0,
    'cached_tokens_string: cacheReadTokens 字符串被守卫 → 0（数字，不是 "080"）',
    JSON.stringify(ext),
  );
  assert(
    usage?.cacheReadTokens === 0,
    'cached_tokens_string: llm_usage.cacheReadTokens 也是数字 0',
    JSON.stringify(usage),
  );
}

async function main(): Promise<void> {
  console.log('=== zhipu cache offline smoke ===');
  await caseHappyPath();
  await caseUsageChunkMissing();
  await caseCachedTokensZero();
  await caseDetailsFieldMissing();
  await caseDetailsNull();
  await caseSseBrokenTail();
  await caseCachedTokensString();

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
