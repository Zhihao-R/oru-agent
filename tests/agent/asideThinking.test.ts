/**
 * 评点思考开关（二期 §3）——disableReasoning 语义升级为「各后端用自己的手段关思考」：
 *
 * - ClaudeCode：engine 入参 maxThinkingTokens **恒为 0**——后端默认就压住自适应思考治"慢"
 *   （实测 SDK 0.1.77：0 能压住、undefined 会非确定触发 thinking 块吃延迟，见 claudeAgentSdk.ts 注释）。
 *   disableReasoning 传不传都是 0（同值），不再是该字段的决定因素
 * - OpenAICompatible（OR 路径）：runConversation 的 disableReasoning → 请求体
 *   reasoning: { enabled: false }；不传时维持原行为（supportsReasoning 决定 effort 注入）
 * - Anthropic：本来就不开 thinking，noop——无新增字段可断言，不设用例
 * - factory：asideComment 用途拿到 twinMain 工具桶（短聊「能看能查」的白名单工具
 *   注册在 twinMain 名下；Task/bash 例外与 twinSubagent 同口径）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentTool, ConversationInput } from '@shared/agent/backend';
import { singleUserTurn } from '../../electron/main/agent/singleUserTurn';
import type { Settings } from '@shared/types';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';

const { engineRunCalls, mcpServerConfigs } = vi.hoisted(() => ({
  engineRunCalls: [] as EngineRunInput[],
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

vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

import { getSettings } from '../../electron/main/projects/store';
import { makeToolContext } from '../helpers/toolContext';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';
import {
  getBackendFor,
  registerTool,
  __clearToolRegistryForTest,
} from '../../electron/main/agent/backends/factory';

const toolContext = makeToolContext({
  conversationId: 'conv-1',
  agentId: 'agent-1',
  ownerId: 'owner-1',
});

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
    // 耗尽流，断言在 engine 入参 / 请求体上做
  }
}

afterEach(() => {
  engineRunCalls.length = 0;
  mcpServerConfigs.length = 0;
  __clearToolRegistryForTest();
});

// ─── ClaudeCode：disableReasoning → maxThinkingTokens: 0 ───────────

describe('ClaudeCodeBackend 思考开关', () => {
  it('runOneShot disableReasoning:true → engine 收到 maxThinkingTokens: 0', async () => {
    const backend = new ClaudeCodeBackend();
    await backend.runOneShot({ prompt: '短评', disableReasoning: true });
    expect(engineRunCalls.at(-1)!.maxThinkingTokens).toBe(0);
  });

  it('runOneShot 不传 disableReasoning → 仍是 maxThinkingTokens: 0（后端默认压思考治慢）', async () => {
    const backend = new ClaudeCodeBackend();
    await backend.runOneShot({ prompt: '短评' });
    expect(engineRunCalls.at(-1)!.maxThinkingTokens).toBe(0);
  });

  it('runConversation disableReasoning:true → engine 收到 maxThinkingTokens: 0', async () => {
    const backend = new ClaudeCodeBackend();
    await drain(
      backend.runConversation(makeConversationInput({ disableReasoning: true })).events,
    );
    expect(engineRunCalls.at(-1)!.maxThinkingTokens).toBe(0);
  });

  it('runConversation 不传 → 仍是 maxThinkingTokens: 0（后端默认压思考治慢）', async () => {
    const backend = new ClaudeCodeBackend();
    await drain(backend.runConversation(makeConversationInput({})).events);
    expect(engineRunCalls.at(-1)!.maxThinkingTokens).toBe(0);
  });

  it('runConversation disableReasoning:false → maxThinkingTokens undefined（aside 思考开关打开放开思考）', async () => {
    const backend = new ClaudeCodeBackend();
    await drain(backend.runConversation(makeConversationInput({ disableReasoning: false })).events);
    expect(engineRunCalls.at(-1)!.maxThinkingTokens).toBeUndefined();
  });

  it('streaming 由调用方驱动：传 true → engine 收到 streaming:true', async () => {
    const backend = new ClaudeCodeBackend();
    await drain(backend.runConversation(makeConversationInput({ streaming: true })).events);
    expect(engineRunCalls.at(-1)!.streaming).toBe(true);
  });

  it('streaming 不传 → engine 缺省关（只取终值的路径不白付增量成本）', async () => {
    const backend = new ClaudeCodeBackend();
    await drain(backend.runConversation(makeConversationInput({})).events);
    expect(engineRunCalls.at(-1)!.streaming).toBeFalsy();
  });

  it('runOneShot 不开 streaming（engine.run 不传该字段）', async () => {
    const backend = new ClaudeCodeBackend();
    await backend.runOneShot({ prompt: '短评' });
    expect(engineRunCalls.at(-1)!.streaming).toBeFalsy();
  });
});

// ─── OpenAICompatible（OR）：disableReasoning → reasoning:{enabled:false} ──

async function startFakeSse(): Promise<{
  baseURL: string;
  receivedBodies: unknown[];
  close: () => Promise<void>;
}> {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '短评' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  const receivedBodies: unknown[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(sse);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${addr.port}`,
    receivedBodies,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

function makeOrBackend(baseURL: string, supportsReasoning?: boolean): OpenAICompatibleBackend {
  return new OpenAICompatibleBackend({
    apiKey: 'sk-fake',
    defaultModel: 'some/model',
    baseURL,
    providerType: 'openrouter',
    supportsReasoning,
    reasoningEffort: 'medium',
  });
}

describe('OpenAICompatibleBackend（OR）思考开关', () => {
  it('runConversation disableReasoning:true → 请求体 reasoning:{enabled:false}（压过 supportsReasoning）', async () => {
    const fake = await startFakeSse();
    try {
      const backend = makeOrBackend(fake.baseURL, true);
      await drain(backend.runConversation(makeConversationInput({ disableReasoning: true })).events);
      const body = fake.receivedBodies[0] as { reasoning?: unknown };
      expect(body.reasoning).toEqual({ enabled: false });
    } finally {
      await fake.close();
    }
  });

  it('不传 disableReasoning：supportsReasoning 模型仍注入 effort（零回归）', async () => {
    const fake = await startFakeSse();
    try {
      const backend = makeOrBackend(fake.baseURL, true);
      await drain(backend.runConversation(makeConversationInput({})).events);
      const body = fake.receivedBodies[0] as { reasoning?: unknown };
      expect(body.reasoning).toEqual({ effort: 'medium' });
    } finally {
      await fake.close();
    }
  });

  it('不传 disableReasoning：非 reasoning 模型请求体无 reasoning 字段（零回归）', async () => {
    const fake = await startFakeSse();
    try {
      const backend = makeOrBackend(fake.baseURL, false);
      await drain(backend.runConversation(makeConversationInput({})).events);
      const body = fake.receivedBodies[0] as { reasoning?: unknown };
      expect(body.reasoning).toBeUndefined();
    } finally {
      await fake.close();
    }
  });
});

// ─── factory：asideComment 用途的工具桶 = twinMain − Task/bash ──────

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `测试工具 ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ text: 'ok' }),
  } satisfies AgentTool;
}

function emptySettings(): Settings {
  return {
    theme: 'system',
    colorScheme: 'terracotta',
    manualApiKey: null,
    providers: [],
    models: [],
    modelAssignments: {
      twinMain: null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: null,
      conversationSummary: null,
      conversationTitle: null,
      twinSubagent: null,
      asideComment: null,
    },
  };
}

describe('factory：asideComment 工具桶继承 twinMain', () => {
  it('twinMain 注册的工具对 asideComment backend 可见（Task/bash 除外）', async () => {
    vi.mocked(getSettings).mockResolvedValue(emptySettings());
    registerTool(makeTool('read_file'), ['twinMain']);
    registerTool(makeTool('Task'), ['twinMain']);
    registerTool(makeTool('bash'), ['twinMain']);

    const backend = await getBackendFor('asideComment');
    await drain(backend.runConversation(makeConversationInput({})).events);

    const bridged = mcpServerConfigs.at(-1)!.tools.map((t) => t.name).sort();
    expect(bridged).toEqual(['read_file']);
  });
});
