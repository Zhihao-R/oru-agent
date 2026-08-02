/**
 * runOneShot 消费 OneShotInput.images——三 backend 各自验证：
 * - 带 images：请求体里图片块形状正确（mediaType/base64 落位），文本与图片同在一条 user 消息（图在前、文在后）
 * - 不带 images：请求形状与改动前完全一致（user content 仍是纯字符串，无回归）
 *
 * Anthropic / OpenAICompatible 用本地 fake HTTP server 拦截真实请求体断言（同 smoke 范式，
 * 不 mock SDK 内部）；ClaudeCode 走 engine 模块 mock（satisfies CodeExecutionEngine）断言
 * engine.run 收到的 prompt 形态。
 */
import { describe, expect, it, vi, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';

// ─── ClaudeCode 的 engine mock ──────────────────────────────────

const { engineRunCalls } = vi.hoisted(() => ({
  engineRunCalls: [] as unknown[],
}));

vi.mock('../../electron/main/engine', () => {
  const engine = {
    run: (input: EngineRunInput): EngineRunHandle => {
      engineRunCalls.push(input);
      return {
        events: (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'result', resultText: '短评', isError: false };
        })(),
      };
    },
    mcp: {
      createServer: () => ({}),
      defineTool: () => ({}),
    },
  } satisfies CodeExecutionEngine;
  return { engine };
});

import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';

// ─── 本地 fake server（记录请求体，按队列返回 JSON 响应） ────────

type FakeResponse = { status: number; json: object };

async function startFakeServer(responses: FakeResponse[]): Promise<{
  baseURL: string;
  receivedBodies: unknown[];
  close: () => Promise<void>;
}> {
  const receivedBodies: unknown[] = [];
  let idx = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
    const r = responses[idx] ?? { status: 500, json: { error: 'no more responses' } };
    idx += 1;
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(r.json));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${addr.port}`,
    receivedBodies,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Anthropic 非流式 messages 响应 */
const anthropicOkResponse: FakeResponse = {
  status: 200,
  json: {
    id: 'msg_t',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '短评' }],
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  },
};

/** OpenAI 兼容 chat/completions 响应 */
const oaiOkResponse: FakeResponse = {
  status: 200,
  json: {
    choices: [{ message: { content: '短评' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
};

const IMG = { base64: 'QUJD', mediaType: 'image/png' };
const IMG2 = { base64: 'REVG', mediaType: 'image/jpeg' };

// ─── AnthropicBackend ───────────────────────────────────────────

describe('AnthropicBackend runOneShot images', () => {
  it('带 images：单条 user 消息，content 为 [image vision block, text]，base64/mediaType 落位', async () => {
    const fake = await startFakeServer([anthropicOkResponse]);
    try {
      const backend = new AnthropicBackend({
        apiKey: 'sk-fake',
        defaultModel: 'claude-sonnet-4-6',
        baseURL: fake.baseURL,
      });
      const result = await backend.runOneShot({ prompt: '评一下这张图', images: [IMG] });
      expect(result.text).toBe('短评');

      const body = fake.receivedBodies[0] as { messages: Array<{ role: string; content: unknown }> };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
        { type: 'text', text: '评一下这张图' },
      ]);
    } finally {
      await fake.close();
    }
  });

  it('不带 images：user content 仍是纯字符串（旧形状无回归）', async () => {
    const fake = await startFakeServer([anthropicOkResponse]);
    try {
      const backend = new AnthropicBackend({
        apiKey: 'sk-fake',
        defaultModel: 'claude-sonnet-4-6',
        baseURL: fake.baseURL,
      });
      await backend.runOneShot({ prompt: '纯文本调用' });

      const body = fake.receivedBodies[0] as { messages: Array<{ role: string; content: unknown }> };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe('纯文本调用');
    } finally {
      await fake.close();
    }
  });
});

// ─── OpenAICompatibleBackend ────────────────────────────────────

function makeOaiBackend(baseURL: string): OpenAICompatibleBackend {
  return new OpenAICompatibleBackend({
    apiKey: 'sk-fake',
    defaultModel: 'gpt-5',
    baseURL,
    providerType: 'openai',
  });
}

describe('OpenAICompatibleBackend runOneShot images', () => {
  it('带 images：user content 为 [image_url data URL, text]，data URL 拼接正确', async () => {
    const fake = await startFakeServer([oaiOkResponse]);
    try {
      const result = await makeOaiBackend(fake.baseURL).runOneShot({
        prompt: '评一下这张图',
        images: [IMG],
      });
      expect(result.text).toBe('短评');

      const body = fake.receivedBodies[0] as { messages: Array<{ role: string; content: unknown }> };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[0].content).toEqual([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'text', text: '评一下这张图' },
      ]);
    } finally {
      await fake.close();
    }
  });

  it('不带 images：user content 仍是纯字符串（旧形状无回归）', async () => {
    const fake = await startFakeServer([oaiOkResponse]);
    try {
      await makeOaiBackend(fake.baseURL).runOneShot({ prompt: '纯文本调用' });

      const body = fake.receivedBodies[0] as { messages: Array<{ role: string; content: unknown }> };
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe('纯文本调用');
    } finally {
      await fake.close();
    }
  });

  it('带 images + outputSchema 回退路径：schema 文案追加成 text 块，不破坏多模态 array', async () => {
    // 第一次 response_format: json_schema 请求 400 → 回退 prompt 注入再调一次
    const fake = await startFakeServer([
      { status: 400, json: { error: 'response_format not supported' } },
      oaiOkResponse,
    ]);
    try {
      await makeOaiBackend(fake.baseURL).runOneShot({
        prompt: '评一下这张图',
        images: [IMG],
        outputSchema: { type: 'object' },
      });

      expect(fake.receivedBodies).toHaveLength(2);
      // 首请求走 response_format: json_schema，content 不注入 schema 文案（注入只属于回退路径）
      const firstBody = fake.receivedBodies[0] as {
        response_format?: { type?: string };
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      };
      expect(firstBody.response_format?.type).toBe('json_schema');
      expect(firstBody.messages[0].content).toEqual([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        { type: 'text', text: '评一下这张图' },
      ]);
      const retryBody = fake.receivedBodies[1] as {
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      };
      const content = retryBody.messages[0].content;
      // 形态保持 array：图片块在前，原文本块居中，schema 注入块在尾
      expect(content[0].type).toBe('image_url');
      expect(content[1]).toEqual({ type: 'text', text: '评一下这张图' });
      expect(content[2].type).toBe('text');
      expect(content[2].text).toContain('合法 JSON');
    } finally {
      await fake.close();
    }
  });
});

// ─── ClaudeCodeBackend ──────────────────────────────────────────

describe('ClaudeCodeBackend runOneShot images', () => {
  afterAll(() => {
    engineRunCalls.length = 0;
  });

  it('带 images：engine.run 收到多模态 prompt 块（图在前、文在后），base64/mediaType 落位', async () => {
    const backend = new ClaudeCodeBackend();
    const result = await backend.runOneShot({ prompt: '评一下这张图', images: [IMG] });
    expect(result.text).toBe('短评');

    const input = engineRunCalls.at(-1) as EngineRunInput;
    expect(input.prompt).toEqual([
      { type: 'image', base64: 'QUJD', mediaType: 'image/png' },
      { type: 'text', text: '评一下这张图' },
    ]);
  });

  it('双图：图片块按入参顺序保序，文本仍在最后', async () => {
    const backend = new ClaudeCodeBackend();
    await backend.runOneShot({ prompt: '比较这两张图', images: [IMG, IMG2] });

    const input = engineRunCalls.at(-1) as EngineRunInput;
    expect(input.prompt).toEqual([
      { type: 'image', base64: 'QUJD', mediaType: 'image/png' },
      { type: 'image', base64: 'REVG', mediaType: 'image/jpeg' },
      { type: 'text', text: '比较这两张图' },
    ]);
  });

  it('不带 images：prompt 仍是纯字符串（旧形状无回归）', async () => {
    const backend = new ClaudeCodeBackend();
    await backend.runOneShot({ prompt: '纯文本调用' });

    const input = engineRunCalls.at(-1) as EngineRunInput;
    expect(input.prompt).toBe('纯文本调用');
  });
});
