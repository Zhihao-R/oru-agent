/**
 * OpenRouter 路径下 cache_control + reasoning 注入 smoke
 *
 * 验证 OpenAICompatibleBackend 仅对 providerType==='openrouter' 注入这两个字段；
 * 其他 OpenAI 兼容 provider（zhipu / kimi / openai）保持原 string + 不带 reasoning。
 *
 * 用 fake HTTP server 拦截 /v1/chat/completions body 做断言。
 */
import './__smoke_isolate__';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';
import type { BackendProviderType } from '@shared/types';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function startFakeServer(): Promise<{
  baseURL: string;
  receivedBodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const receivedBodies: Array<Record<string, unknown>> = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
      receivedBodies.push(body);
      // 一发就完结：单 content chunk + finish=stop + DONE
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: [DONE]\n\n`);
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
    close: () => new Promise((r) => server.close(() => r())),
  };
}

type RunOpts = {
  providerType: BackendProviderType;
  supportsPromptCache?: boolean;
  supportsReasoning?: boolean;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  systemContext?: string;
  stableSystemContext?: string;
  sessionStableSystemContext?: string;
};

async function runOnce(opts: RunOpts): Promise<Record<string, unknown>> {
  const fake = await startFakeServer();
  try {
    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk-fake',
      defaultModel: 'm',
      baseURL: fake.baseURL,
      providerType: opts.providerType,
      supportsPromptCache: opts.supportsPromptCache,
      supportsReasoning: opts.supportsReasoning,
      reasoningEffort: opts.reasoningEffort,
    });
    const handle = backend.runConversation({
      agentId: 'smoke-agent',
      conversationId: 'cnv',
      userMessage: 'hi',
      systemContext: opts.systemContext,
      stableSystemContext: opts.stableSystemContext,
      sessionStableSystemContext: opts.sessionStableSystemContext,
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
    for await (const _ev of handle.events) {
      void _ev;
    }
    return fake.receivedBodies[0];
  } finally {
    await fake.close();
  }
}

type ContentPart = { type: 'text'; text: string; cache_control?: { type: string } };

async function caseOrCacheSplitsSystem(): Promise<void> {
  const stable = 'STABLE PREFIX 稳定段——人设和环境约定。\n';
  const dynamic = 'DYNAMIC 动态段——dream / promptHints。';
  const body = await runOnce({
    providerType: 'openrouter',
    supportsPromptCache: true,
    systemContext: stable + dynamic,
    stableSystemContext: stable,
  });
  const msgs = body.messages as Array<{ role: string; content: unknown }>;
  const sys = msgs.find((m) => m.role === 'system');
  assert(!!sys, 'OR+cache: 含 system message');
  assert(Array.isArray(sys?.content), 'OR+cache: system.content 是 array form', JSON.stringify(sys?.content).slice(0, 120));
  if (Array.isArray(sys?.content)) {
    const parts = sys.content as ContentPart[];
    assert(parts.length === 2, 'OR+cache: 2 个 text part', String(parts.length));
    assert(parts[0]?.text === stable, 'OR+cache: 第 1 part === stable', parts[0]?.text?.slice(0, 30));
    assert(
      parts[0]?.cache_control?.type === 'ephemeral',
      'OR+cache: 第 1 part 打 cache_control:ephemeral',
      JSON.stringify(parts[0]?.cache_control),
    );
    assert(parts[1]?.text === dynamic, 'OR+cache: 第 2 part === dynamic', parts[1]?.text?.slice(0, 30));
    assert(parts[1]?.cache_control === undefined, 'OR+cache: 第 2 part 不打 cache_control', JSON.stringify(parts[1]?.cache_control));
  }
}

async function caseOrCacheTwoTier(): Promise<void> {
  // Task 3：主对话传 sessionStable（stable + 能力 + 快照）→ 三段、两个 cache_control breakpoint。
  // 第 1 段 = 纯 stable（供子 agent 复用），第 2 段 = 含快照的会话级稳定段（主对话缓存它），
  // 第 3 段 = 动态（当前时间），不打标。
  const SEP = '\n\n---\n\n';
  const stable = '人设：我是 Twin';
  const mid = `${SEP}能力：联网${SEP}记忆快照：用户叫阮子`;
  const dynamic = `${SEP}当前时间：2026-06-02`;
  const sessionStable = stable + mid;
  const body = await runOnce({
    providerType: 'openrouter',
    supportsPromptCache: true,
    systemContext: sessionStable + dynamic,
    stableSystemContext: stable,
    sessionStableSystemContext: sessionStable,
  });
  const sys = (body.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'system');
  if (Array.isArray(sys?.content)) {
    const parts = sys.content as ContentPart[];
    assert(parts.length === 3, 'OR+两层: 3 个 part', String(parts.length));
    assert(parts[0]?.text === stable, 'OR+两层: 第 1 段 = 纯 stable（子 agent 复用）', parts[0]?.text);
    assert(parts[0]?.cache_control?.type === 'ephemeral', 'OR+两层: 第 1 段打 cache_control');
    assert(parts[1]?.text === mid && parts[1]?.text.includes('快照'), 'OR+两层: 第 2 段 = 含快照的会话级稳定段', parts[1]?.text?.slice(0, 30));
    assert(parts[1]?.cache_control?.type === 'ephemeral', 'OR+两层: 第 2 段也打 cache_control（第二 breakpoint）');
    assert(parts[2]?.text === dynamic, 'OR+两层: 第 3 段 = 动态', parts[2]?.text);
    assert(parts[2]?.cache_control === undefined, 'OR+两层: 第 3 段不打 cache_control');
    assert(parts.filter((p) => p.cache_control).length === 2, 'OR+两层: 恰好两个 cache breakpoint');
  } else {
    assert(false, 'OR+两层: 应为 array form', String(typeof sys?.content));
  }
}

async function caseOrCacheNoStableFallback(): Promise<void> {
  // 有 cache 开关但 runner 没传 stable → 整段当 dynamic，回退为 string，不打标
  const body = await runOnce({
    providerType: 'openrouter',
    supportsPromptCache: true,
    systemContext: 'just a system message no stable prefix',
  });
  const msgs = body.messages as Array<{ role: string; content: unknown }>;
  const sys = msgs.find((m) => m.role === 'system');
  assert(typeof sys?.content === 'string', 'OR+cache 无 stable: system.content 回退为 string', String(typeof sys?.content));
}

async function caseOrCacheStableEqualsFull(): Promise<void> {
  // stable === full（dynamic 为空）→ 单 part array，只打 cache_control
  const body = await runOnce({
    providerType: 'openrouter',
    supportsPromptCache: true,
    systemContext: 'ALL STABLE',
    stableSystemContext: 'ALL STABLE',
  });
  const sys = (body.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'system');
  if (Array.isArray(sys?.content)) {
    const parts = sys.content as ContentPart[];
    assert(parts.length === 1, 'OR+cache 全 stable: 1 个 part', String(parts.length));
    assert(parts[0]?.cache_control?.type === 'ephemeral', 'OR+cache 全 stable: 该 part 打 cache_control');
  } else {
    assert(false, 'OR+cache 全 stable: 应该是 array form', String(typeof sys?.content));
  }
}

async function caseOrCacheOffStaysString(): Promise<void> {
  // OR 但 supportsPromptCache=false → 整段 string，不注入 cache_control
  const body = await runOnce({
    providerType: 'openrouter',
    supportsPromptCache: false,
    systemContext: 'system text',
    stableSystemContext: 'system',
  });
  const sys = (body.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'system');
  assert(typeof sys?.content === 'string', 'OR+cache off: system.content 仍是 string', String(typeof sys?.content));
}

async function caseNonOrNeverSplits(): Promise<void> {
  // 非 OR provider 即使开了 supportsPromptCache 也不注入 cache_control
  for (const t of ['zhipu', 'kimi', 'openai'] as BackendProviderType[]) {
    const body = await runOnce({
      providerType: t,
      supportsPromptCache: true,
      systemContext: 'STABLE + DYNAMIC',
      stableSystemContext: 'STABLE ',
    });
    const sys = (body.messages as Array<{ role: string; content: unknown }>).find((m) => m.role === 'system');
    assert(typeof sys?.content === 'string', `${t}: 不注入 cache_control（system 仍 string）`, String(typeof sys?.content));
    assert(!('reasoning' in body), `${t}: body 不带 reasoning`);
  }
}

async function caseOrReasoningInjectedDefault(): Promise<void> {
  const body = await runOnce({
    providerType: 'openrouter',
    supportsReasoning: true,
  });
  assert(
    typeof body.reasoning === 'object' && body.reasoning !== null,
    'OR+reasoning: body.reasoning 存在',
    JSON.stringify(body.reasoning),
  );
  assert(
    (body.reasoning as { effort?: string })?.effort === 'medium',
    'OR+reasoning: 默认 effort=medium',
    JSON.stringify(body.reasoning),
  );
}

async function caseOrReasoningCustomEffort(): Promise<void> {
  const body = await runOnce({
    providerType: 'openrouter',
    supportsReasoning: true,
    reasoningEffort: 'high',
  });
  assert(
    (body.reasoning as { effort?: string })?.effort === 'high',
    'OR+reasoning: effort=high 透传',
    JSON.stringify(body.reasoning),
  );
}

async function caseOrReasoningOffOmitsField(): Promise<void> {
  const body = await runOnce({
    providerType: 'openrouter',
    supportsReasoning: false,
  });
  assert(!('reasoning' in body), 'OR+reasoning off: body 完全不带 reasoning 字段');
}

async function caseNonOrReasoningOmitted(): Promise<void> {
  // 即使其他 provider 标了 supportsReasoning，也不注入 reasoning
  for (const t of ['openai', 'zhipu', 'kimi'] as BackendProviderType[]) {
    const body = await runOnce({
      providerType: t,
      supportsReasoning: true,
      reasoningEffort: 'high',
    });
    assert(!('reasoning' in body), `${t}: supportsReasoning=true 也不注入 reasoning`);
  }
}

async function main(): Promise<void> {
  console.log('=== openrouter_cache_reasoning_injection smoke ===');
  await caseOrCacheSplitsSystem();
  await caseOrCacheTwoTier();
  await caseOrCacheNoStableFallback();
  await caseOrCacheStableEqualsFull();
  await caseOrCacheOffStaysString();
  await caseNonOrNeverSplits();
  await caseOrReasoningInjectedDefault();
  await caseOrReasoningCustomEffort();
  await caseOrReasoningOffOmitsField();
  await caseNonOrReasoningOmitted();

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
