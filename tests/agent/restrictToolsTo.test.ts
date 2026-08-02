/**
 * 随手评点（aside）只读白名单收口——backend 侧（T4）：
 *
 * - factory：listRegisteredToolNames 正式枚举导出（注册表全量超集）
 * - Anthropic / OpenAICompatible：restrictToolsTo 存在时请求体 tools 恰为"白名单 ∩ 已注册"；
 *   undefined 时全量无回归（fake HTTP server 断言真实请求体，同 runOneShotImages 范式）
 * - ClaudeCode 两个面：① oru MCP server 只桥白名单工具（外部 MCP 反射工具按裸名白名单自然滤掉）
 *   ② restrict 时 builtinTools=[] 禁全部 SDK 内置工具（+ 不加载 settings 来源）；
 *   默认路径 builtinTools=allowlist（D3-a，全集快照∖denylist，非回归 + fail-closed）+ 加载 settings
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AgentTool, ConversationInput } from '@shared/agent/backend';
import { singleUserTurn } from '../../electron/main/agent/singleUserTurn';
import { makeToolContext } from '../helpers/toolContext';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';

// ─── ClaudeCode 的 engine mock（satisfies 真接口，接口变了编译期就红） ──────

const { engineRunCalls, mcpServerConfigs } = vi.hoisted(() => ({
  engineRunCalls: [] as EngineRunInput[],
  /** createServer 收到的 config（tools 数组元素是 defineTool 返回的 { name }） */
  mcpServerConfigs: [] as Array<{ name: string; tools: Array<{ name: string }> }>,
}));

vi.mock('../../electron/main/engine', () => {
  const engine = {
    run: (input: EngineRunInput): EngineRunHandle => {
      engineRunCalls.push(input);
      return {
        events: (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'result', resultText: 'ok', isError: false };
        })(),
      };
    },
    mcp: {
      createServer: (config: { name: string; version: string; tools: Array<{ name: string }> }) => {
        mcpServerConfigs.push({ name: config.name, tools: config.tools });
        return {};
      },
      defineTool: (name: string) => ({ name }),
    },
  } satisfies CodeExecutionEngine;
  return { engine };
});

// factory 依赖 projects/store 的 getSettings——本文件只用注册表函数，桩掉避免拉起真实 settings
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';
import {
  registerTool,
  listRegisteredToolNames,
  __clearToolRegistryForTest,
} from '../../electron/main/agent/backends/factory';

// ─── 共用 fixture ───────────────────────────────────────────────

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `测试工具 ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ text: 'ok' }),
  } satisfies AgentTool;
}

const toolContext = makeToolContext({ conversationId: 'conv-1', agentId: 'agent-1', ownerId: 'owner-1' });

function makeConversationInput(overrides: Partial<ConversationInput>): ConversationInput {
  return {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    userMessage: '随手评点一下',
    // HTTP 后端只 replay history、不读 userMessage——当前 user 轮必须在 history 末尾（生产同款 singleUserTurn）
    history: singleUserTurn('conv-1', '随手评点一下'),
    cwd: process.cwd(),
    abortController: new AbortController(),
    toolContext,
    ...overrides,
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of events) {
    // 只为耗尽流，断言在请求体 / engine 入参上做
  }
}

// ─── fake HTTP server（SSE 流式，记录请求体；数组 = 按请求序号轮流响应，末项兜底） ──

async function startFakeSse(sseBody: string | string[]): Promise<{
  baseURL: string;
  receivedBodies: unknown[];
  close: () => Promise<void>;
}> {
  const bodies = Array.isArray(sseBody) ? sseBody : [sseBody];
  const receivedBodies: unknown[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(bodies[Math.min(receivedBodies.length - 1, bodies.length - 1)]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${addr.port}`,
    receivedBodies,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Anthropic 纯文本单轮 SSE 响应 */
const anthropicSse = [
  { name: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } } },
  { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '短评' } } },
  { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
  { name: 'message_stop', data: { type: 'message_stop' } },
]
  .map((ev) => `event: ${ev.name}\ndata: ${JSON.stringify(ev.data)}\n\n`)
  .join('');

/** OpenAI 兼容纯文本单轮 SSE 响应 */
const oaiSse = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: '短评' }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('');

/** Anthropic 单工具调用 SSE 响应（模型点名 toolName）——下一请求由数组兜底项接续 */
function anthropicToolUseSse(toolName: string): string {
  return [
    { name: 'message_start', data: { type: 'message_start', message: { id: 'msg_t', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } } } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: toolName, input: {} } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } } },
    { name: 'message_stop', data: { type: 'message_stop' } },
  ]
    .map((ev) => `event: ${ev.name}\ndata: ${JSON.stringify(ev.data)}\n\n`)
    .join('');
}

/** OpenAI 兼容单工具调用 SSE 响应 */
function oaiToolUseSse(toolName: string): string {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: toolName, arguments: '{}' } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

/** 收集事件流（drain 之外还要断言 tool_result 回执） */
async function collect(events: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const ev of events) out.push(ev as Record<string, unknown>);
  return out;
}

// ─── factory：注册表枚举导出 ────────────────────────────────────

describe('factory listRegisteredToolNames', () => {
  afterEach(() => {
    __clearToolRegistryForTest();
  });

  it('返回注册表全量工具名（不分 usage——枚举即超集）', () => {
    registerTool(makeTool('read_file'), ['twinMain']);
    registerTool(makeTool('propose_action'), ['twinMain']);
    registerTool(makeTool('mcp__chrome__click'), ['twinBackground']);
    expect(listRegisteredToolNames().sort()).toEqual([
      'mcp__chrome__click',
      'propose_action',
      'read_file',
    ]);
  });
});

// ─── AnthropicBackend ───────────────────────────────────────────

function makeAnthropicBackend(baseURL: string): AnthropicBackend {
  const backend = new AnthropicBackend({
    apiKey: 'sk-fake',
    defaultModel: 'claude-sonnet-4-6',
    baseURL,
  });
  backend.registerTool(makeTool('read_file'));
  backend.registerTool(makeTool('propose_action'));
  return backend;
}

describe('AnthropicBackend restrictToolsTo', () => {
  it('白名单存在时：请求体 tools 恰为"白名单 ∩ 已注册"（未注册名静默忽略）', async () => {
    const fake = await startFakeSse(anthropicSse);
    try {
      const handle = makeAnthropicBackend(fake.baseURL).runConversation(
        makeConversationInput({ restrictToolsTo: ['read_file', 'not_registered'] }),
      );
      await drain(handle.events);

      const body = fake.receivedBodies[0] as { tools?: Array<{ name: string }> };
      expect(body.tools?.map((t) => t.name)).toEqual(['read_file']);
    } finally {
      await fake.close();
    }
  });

  it('undefined 时：全量已注册工具照常暴露（无回归）', async () => {
    const fake = await startFakeSse(anthropicSse);
    try {
      const handle = makeAnthropicBackend(fake.baseURL).runConversation(makeConversationInput({}));
      await drain(handle.events);

      const body = fake.receivedBodies[0] as { tools?: Array<{ name: string }> };
      expect(body.tools?.map((t) => t.name).sort()).toEqual(['propose_action', 'read_file']);
    } finally {
      await fake.close();
    }
  });
});

// ─── OpenAICompatibleBackend ────────────────────────────────────

function makeOaiBackend(baseURL: string): OpenAICompatibleBackend {
  const backend = new OpenAICompatibleBackend({
    apiKey: 'sk-fake',
    defaultModel: 'gpt-5',
    baseURL,
    providerType: 'openai',
  });
  backend.registerTool(makeTool('read_file'));
  backend.registerTool(makeTool('propose_action'));
  return backend;
}

describe('OpenAICompatibleBackend restrictToolsTo', () => {
  it('白名单存在时：请求体 tools 恰为"白名单 ∩ 已注册"', async () => {
    const fake = await startFakeSse(oaiSse);
    try {
      const handle = makeOaiBackend(fake.baseURL).runConversation(
        makeConversationInput({ restrictToolsTo: ['read_file', 'not_registered'] }),
      );
      await drain(handle.events);

      const body = fake.receivedBodies[0] as { tools?: Array<{ function: { name: string } }> };
      expect(body.tools?.map((t) => t.function.name)).toEqual(['read_file']);
    } finally {
      await fake.close();
    }
  });

  it('undefined 时：全量已注册工具照常暴露（无回归）', async () => {
    const fake = await startFakeSse(oaiSse);
    try {
      const handle = makeOaiBackend(fake.baseURL).runConversation(makeConversationInput({}));
      await drain(handle.events);

      const body = fake.receivedBodies[0] as { tools?: Array<{ function: { name: string } }> };
      expect(body.tools?.map((t) => t.function.name).sort()).toEqual([
        'propose_action',
        'read_file',
      ]);
    } finally {
      await fake.close();
    }
  });
});

// ─── ClaudeCodeBackend（两个面） ────────────────────────────────

function makeClaudeCodeBackend(): ClaudeCodeBackend {
  const backend = new ClaudeCodeBackend('claude-opus-4-8');
  backend.registerTool(makeTool('read_file'));
  backend.registerTool(makeTool('propose_action'));
  // 外部 MCP 的反射工具：2026-07-27 起与自有工具同路进 this.tools（不再走 SDK 原生透传）
  backend.registerTool(makeTool('mcp__chrome-devtools__click'));
  return backend;
}

describe('ClaudeCodeBackend restrictToolsTo', () => {
  afterEach(() => {
    engineRunCalls.length = 0;
    mcpServerConfigs.length = 0;
  });

  it('白名单存在时两面收口：oru 只桥白名单工具 / 外部 MCP 反射工具被滤掉 / builtinTools=[] 且不加载 settings', async () => {
    const handle = makeClaudeCodeBackend().runConversation(
      makeConversationInput({ restrictToolsTo: ['read_file', 'not_registered'] }),
    );
    await drain(handle.events);

    const input = engineRunCalls.at(-1)!;
    // 面①：oru MCP server 只含白名单工具（桥接前按裸名过滤，无前缀映射问题）
    expect(mcpServerConfigs).toHaveLength(1);
    expect(mcpServerConfigs[0].name).toBe('oru');
    expect(mcpServerConfigs[0].tools.map((t) => t.name)).toEqual(['read_file']);
    // 面②：外部 MCP 的反射工具不进桥接列表——白名单按裸名过滤，mcp__* 注册名自然落选。
    // （旧实现这一面靠「不透传 mcpServers」独立成立，透传退场后并入面①，收口不变。）
    expect(mcpServerConfigs[0].tools.map((t) => t.name)).not.toContain('mcp__chrome-devtools__click');
    expect(Object.keys(input.mcpServers ?? {})).toEqual(['oru']);
    // 面③：SDK 内置工具基集置空 + 不加载 settings 来源（.mcp.json / skills 也是工具引入面）
    expect(input.builtinTools).toEqual([]);
    expect(input.loadSettingSources).toBe(false);
  });

  it('白名单与已注册无交集时：连 oru server 都不挂（零工具回合）', async () => {
    const handle = makeClaudeCodeBackend().runConversation(
      makeConversationInput({ restrictToolsTo: ['not_registered'] }),
    );
    await drain(handle.events);

    const input = engineRunCalls.at(-1)!;
    expect(mcpServerConfigs).toHaveLength(0);
    expect(Object.keys(input.mcpServers ?? {})).toEqual([]);
    expect(input.builtinTools).toEqual([]);
  });

  it('默认路径两面无回归：全量桥接（含外部 MCP 反射工具）/ 不再挂原生 mcpServers / builtinTools=allowlist 且加载 settings', async () => {
    const handle = makeClaudeCodeBackend().runConversation(makeConversationInput({}));
    await drain(handle.events);

    const input = engineRunCalls.at(-1)!;
    expect(mcpServerConfigs).toHaveLength(1);
    // 外部 MCP 反射工具跟着一起桥进 'oru'（SDK 再加一层前缀成 mcp__oru__mcp__chrome-devtools__click，
    // normalizeToolName 剥掉外层后正是这个注册名）
    expect(mcpServerConfigs[0].tools.map((t) => t.name).sort()).toEqual([
      'mcp__chrome-devtools__click',
      'propose_action',
      'read_file',
    ]);
    // 原生 mcpServers 只剩 'oru'：外部 server 不再交给 SDK 自己 spawn（每回合新进程 → 反复弹授权）
    expect(Object.keys(input.mcpServers ?? {}).sort()).toEqual(['oru']);
    // D3-a：默认路径不再是 fail-open 的 undefined，而是 allowlist（全集快照 ∖ denylist）。
    // 内置读写工具仍在（不缺工具），已 deny 的不在（详尽双向验在 claudeCodeBuiltinAllowlist.test.ts）。
    expect(input.builtinTools).toContain('Read');
    expect(input.builtinTools).not.toContain('Bash');
    expect(input.loadSettingSources).toBe(true);
  });

  it('反射工具的 schema 转不成 zod 时只跳过它，同批其它工具照挂、回合照起', async () => {
    // 外部 MCP 反射工具带的是第三方 server 的 schema，Oru 管不着它长什么样；
    // jsonSchemaToZodShape 对非 object 的 root schema 直接抛错。不逐工具接住的话，
    // 一个畸形 schema 就让整个 runConversation 抛出去 —— 坏一个工具拖垮整轮对话。
    const backend = makeClaudeCodeBackend();
    backend.registerTool({ ...makeTool('mcp__weird__thing'), inputSchema: { type: 'string' } });

    const handle = backend.runConversation(makeConversationInput({}));
    await drain(handle.events);

    const names = mcpServerConfigs[0].tools.map((t) => t.name);
    expect(names).not.toContain('mcp__weird__thing');
    expect(names).toContain('read_file');
    expect(names).toContain('mcp__chrome-devtools__click');
  });
});

// ─── 执行分发面收口（T4 review 遗留）────────────────────────────
// 声明面过滤只挡「看见」，挡不住「点名」：模型幻觉出「已注册但本回合未声明」的工具名时，
// HTTP 两后端的分发不得直通 this.tools 执行——必须回 isError 回执且工具真的没跑。
// toolContext fixture 的 requireApproval=false 正是信任模式（§10 点名必测：无审批闸时
// 白名单回合说「帮我改文件」也不发生任何真实写入）。

/** 一执行就往 target 写文件的工具——「没写入」即「没执行」的落盘证据 */
function makeForbiddenWriteTool(name: string, target: string): AgentTool {
  return {
    name,
    description: `测试写工具 ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      await fs.writeFile(target, '白名单回合里不该发生的写入');
      return { text: 'written' };
    },
  } satisfies AgentTool;
}

describe('执行分发面与声明面同源（白名单回合的执行收口）', () => {
  const WRITE_TARGET = join(tmpdir(), `oru-test-restrict-write-${Date.now()}.txt`);

  afterEach(async () => {
    await fs.rm(WRITE_TARGET, { force: true });
    engineRunCalls.length = 0;
    mcpServerConfigs.length = 0;
  });

  it('Anthropic：信任模式点名白名单外的写工具 → isError 回执、无真实写入、round-trip 照常续', async () => {
    const fake = await startFakeSse([anthropicToolUseSse('write_file'), anthropicSse]);
    try {
      const backend = new AnthropicBackend({
        apiKey: 'sk-fake',
        defaultModel: 'claude-sonnet-4-6',
        baseURL: fake.baseURL,
      });
      backend.registerTool(makeTool('read_file'));
      backend.registerTool(makeForbiddenWriteTool('write_file', WRITE_TARGET));
      const events = await collect(
        backend.runConversation(makeConversationInput({ restrictToolsTo: ['read_file'] })).events,
      );

      const toolResult = events.find((e) => e.type === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult!.isError).toBe(true);
      expect(String(toolResult!.content)).toContain('不在本回合可用工具集内');
      // 没执行的落盘证据：写工具的 execute 没跑
      expect(existsSync(WRITE_TARGET)).toBe(false);
      // round-trip 照常走完：第二个请求把 is_error 回执喂回模型纠偏
      expect(fake.receivedBodies).toHaveLength(2);
      const second = fake.receivedBodies[1] as {
        messages: Array<{ role: string; content: Array<{ type: string; is_error?: boolean }> }>;
      };
      const lastMsg = second.messages.at(-1)!;
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content[0].type).toBe('tool_result');
      expect(lastMsg.content[0].is_error).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('Anthropic：白名单内的 read 类照常可用（信任模式同回合无误伤）', async () => {
    const fake = await startFakeSse([anthropicToolUseSse('read_file'), anthropicSse]);
    try {
      const backend = new AnthropicBackend({
        apiKey: 'sk-fake',
        defaultModel: 'claude-sonnet-4-6',
        baseURL: fake.baseURL,
      });
      backend.registerTool(makeTool('read_file'));
      backend.registerTool(makeForbiddenWriteTool('write_file', WRITE_TARGET));
      const events = await collect(
        backend.runConversation(makeConversationInput({ restrictToolsTo: ['read_file'] })).events,
      );

      const toolResult = events.find((e) => e.type === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult!.isError).toBe(false);
      expect(toolResult!.content).toBe('ok');
    } finally {
      await fake.close();
    }
  });

  it('OpenAICompatible：信任模式点名白名单外的写工具 → isError 回执、无真实写入、round-trip 照常续', async () => {
    const fake = await startFakeSse([oaiToolUseSse('write_file'), oaiSse]);
    try {
      const backend = new OpenAICompatibleBackend({
        apiKey: 'sk-fake',
        defaultModel: 'gpt-5',
        baseURL: fake.baseURL,
        providerType: 'openai',
      });
      backend.registerTool(makeTool('read_file'));
      backend.registerTool(makeForbiddenWriteTool('write_file', WRITE_TARGET));
      const events = await collect(
        backend.runConversation(makeConversationInput({ restrictToolsTo: ['read_file'] })).events,
      );

      const toolResult = events.find((e) => e.type === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult!.isError).toBe(true);
      expect(String(toolResult!.content)).toContain('不在本回合可用工具集内');
      expect(existsSync(WRITE_TARGET)).toBe(false);
      expect(fake.receivedBodies).toHaveLength(2);
      const second = fake.receivedBodies[1] as {
        messages: Array<{ role: string; content: string }>;
      };
      const lastMsg = second.messages.at(-1)!;
      expect(lastMsg.role).toBe('tool');
      expect(lastMsg.content.startsWith('[error]')).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('ClaudeCode：信任模式白名单回合——写工具不桥进 oru server、SDK 内置全关、无真实写入', async () => {
    const backend = new ClaudeCodeBackend('claude-opus-4-8');
    backend.registerTool(makeTool('read_file'));
    backend.registerTool(makeForbiddenWriteTool('write_file', WRITE_TARGET));
    const handle = backend.runConversation(
      makeConversationInput({ restrictToolsTo: ['read_file'] }),
    );
    await drain(handle.events);

    // 执行面在 SDK 子进程内：模型只可能调「桥进 oru server 的工具」与「SDK 内置工具」，
    // 两面都收口即写不进来；tmp 落盘断言作 belt-and-suspenders（engine 为 mock，工具不会被调）
    const input = engineRunCalls.at(-1)!;
    expect(mcpServerConfigs.at(-1)!.tools.map((t) => t.name)).toEqual(['read_file']);
    expect(input.builtinTools).toEqual([]);
    expect(existsSync(WRITE_TARGET)).toBe(false);
  });
});

// ─── restrictToolsTo 与 disallowedTools 叠加（T4 review 遗留）──────────

describe('restrictToolsTo 与 disallowedTools 叠加：声明面取交集', () => {
  it('Anthropic：白名单 ∩ 非 denylist', async () => {
    const fake = await startFakeSse(anthropicSse);
    try {
      const backend = new AnthropicBackend({
        apiKey: 'sk-fake',
        defaultModel: 'claude-sonnet-4-6',
        baseURL: fake.baseURL,
      });
      backend.registerTool(makeTool('read_file'));
      backend.registerTool(makeTool('grep'));
      backend.registerTool(makeTool('write_file'));
      const handle = backend.runConversation(
        makeConversationInput({
          restrictToolsTo: ['read_file', 'grep'],
          disallowedTools: ['grep'],
        }),
      );
      await drain(handle.events);

      const body = fake.receivedBodies[0] as { tools?: Array<{ name: string }> };
      expect(body.tools?.map((t) => t.name)).toEqual(['read_file']);
    } finally {
      await fake.close();
    }
  });

  it('OpenAICompatible：白名单 ∩ 非 denylist', async () => {
    const fake = await startFakeSse(oaiSse);
    try {
      const backend = new OpenAICompatibleBackend({
        apiKey: 'sk-fake',
        defaultModel: 'gpt-5',
        baseURL: fake.baseURL,
        providerType: 'openai',
      });
      backend.registerTool(makeTool('read_file'));
      backend.registerTool(makeTool('grep'));
      backend.registerTool(makeTool('write_file'));
      const handle = backend.runConversation(
        makeConversationInput({
          restrictToolsTo: ['read_file', 'grep'],
          disallowedTools: ['grep'],
        }),
      );
      await drain(handle.events);

      const body = fake.receivedBodies[0] as { tools?: Array<{ function: { name: string } }> };
      expect(body.tools?.map((t) => t.function.name)).toEqual(['read_file']);
    } finally {
      await fake.close();
    }
  });
});
