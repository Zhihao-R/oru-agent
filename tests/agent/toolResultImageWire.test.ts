/**
 * D2 工具回执图回传——OpenAI 兼容路径 wire 断言（Step1 失败测试）
 *
 * 覆盖：
 *  ① supportsVision=true + 工具带 images → 下一轮请求体出现 role:'user' image_url blocks，
 *     且在所有 role:'tool' 之后、steering 之前（证明 executeToolSafe 真透出 + appendToolResults 真落位）
 *  ② supportsVision=false + 工具带 images → 无 image_url，tool 回执文字含降级占位
 *  ③ 不变量：role:'tool' content 恒为 string，绝不是数组（锁住 string-only 厂商安全）
 *  ④ Anthropic adapter 消费 images：图拼进 tool_result 块数组；无图时形状零变化
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentTool, ConversationInput, ToolResultImage } from '@shared/agent/backend';
import { singleUserTurn } from '../../electron/main/agent/singleUserTurn';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';
import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';

// ─── 公共工具：fake HTTP server ─────────────────────────────────

function sseOAI(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
const OAI_DONE = `data: [DONE]\n\n`;

async function startFakeOpenAI(rounds: string[][]): Promise<{
  baseURL: string;
  receivedBodies: unknown[];
  close: () => Promise<void>;
}> {
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

// Anthropic fake server（用于回归测试）
function sseAnth(name: string, data: object): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startFakeAnthropic(rounds: Array<Array<{ name: string; data: object }>>): Promise<{
  baseURL: string;
  receivedBodies: unknown[];
  close: () => Promise<void>;
}> {
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

// ─── 公共：SSE 响应片段 ─────────────────────────────────────────

/** OpenAI 工具调用轮（返回 render_html 调用） */
function oaiToolCallRound(): string[] {
  return [
    sseOAI({ model: 'gpt-5', choices: [{ delta: { tool_calls: [{ index: 0, id: 'tu1', function: { name: 'render_html', arguments: '{}' } }] }, finish_reason: null }] }),
    sseOAI({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    sseOAI({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }),
    OAI_DONE,
  ];
}

/** OpenAI 结束轮 */
function oaiEndRound(): string[] {
  return [
    sseOAI({ model: 'gpt-5', choices: [{ delta: { content: '页面截图已分析完毕' }, finish_reason: null }] }),
    sseOAI({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sseOAI({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } }),
    OAI_DONE,
  ];
}

/** Anthropic 工具调用轮 */
function anthToolRound(): Array<{ name: string; data: object }> {
  return [
    { name: 'message_start', data: { type: 'message_start', message: { id: 'm1', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'render_html', input: {} } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } } },
    { name: 'message_stop', data: { type: 'message_stop' } },
  ];
}

/** Anthropic 结束轮 */
function anthEndRound(): Array<{ name: string; data: object }> {
  return [
    { name: 'message_start', data: { type: 'message_start', message: { id: 'm2', model: 'claude-sonnet-4-6', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 1 } } } },
    { name: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { name: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已分析' } } },
    { name: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { name: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } } },
    { name: 'message_stop', data: { type: 'message_stop' } },
  ];
}

// ─── 公共：带图的录制工具 ────────────────────────────────────────

const TEST_IMAGE: ToolResultImage = {
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  mediaType: 'image/png',
};

/** 返回带 images 的工具（模拟 render_html/view_slide 行为） */
function renderToolWithImage(name: string): AgentTool {
  return {
    name,
    description: `${name} 渲染并截图`,
    inputSchema: { type: 'object' as const, properties: {} },
    mutatesEnvironment: false, // 渲染/截图类，纯读，不改持久状态
    async execute() {
      return {
        text: '第1页截图已生成',
        images: [TEST_IMAGE],
      };
    },
  } satisfies AgentTool;
}

/** ConversationInput 基础形态 */
const baseInput = (): ConversationInput => ({
  agentId: 'a',
  conversationId: 'c',
  userMessage: '渲染第一页',
  // HTTP 后端只 replay history、不读 userMessage——当前 user 轮必须在 history 末尾（生产同款 singleUserTurn）
  history: singleUserTurn('c', '渲染第一页'),
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

/** 消费 AsyncIterable，返回所有事件 */
async function consumeAll(handle: { events: AsyncIterable<unknown> }): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of handle.events) out.push(ev);
  return out;
}

// ─── cleanup ─────────────────────────────────────────────────────

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
});

// ─── ① supportsVision=true：图进 wire ────────────────────────────

describe('D2 工具图回传：supportsVision=true', () => {
  it('工具带 images → 第二轮请求体含 role:user image_url blocks，在 role:tool 之后', async () => {
    const fake = await startFakeOpenAI([oaiToolCallRound(), oaiEndRound()]);
    cleanup = fake.close;

    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
      supportsVision: true,
    });
    backend.registerTool(renderToolWithImage('render_html'));

    await consumeAll(backend.runConversation(baseInput()));

    // 第二轮请求体（round 2）
    expect(fake.receivedBodies).toHaveLength(2);
    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; content: unknown }> };

    // 必须有 role:'tool' 消息（tool 回执）
    const toolMsgs = body2.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);

    // 必须有 role:'user' 消息带 image_url blocks
    const userMsgsWithImages = body2.messages.filter(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((b) => b.type === 'image_url'),
    );
    expect(userMsgsWithImages.length).toBe(1);

    // image_url 的 url 必须包含正确 data URL 前缀和 base64
    const imgMsg = userMsgsWithImages[0];
    const imgBlocks = (imgMsg.content as Array<{ type: string; image_url?: { url: string } }>).filter(
      (b) => b.type === 'image_url',
    );
    expect(imgBlocks.length).toBe(1);
    expect(imgBlocks[0].image_url?.url).toBe(`data:${TEST_IMAGE.mediaType};base64,${TEST_IMAGE.base64}`);

    // 图消息的索引必须在所有 role:'tool' 消息之后
    const allMessages = body2.messages;
    const lastToolIdx = allMessages.reduce((max, m, i) => (m.role === 'tool' ? i : max), -1);
    const imgMsgIdx = allMessages.indexOf(imgMsg);
    expect(imgMsgIdx).toBeGreaterThan(lastToolIdx);
  });

  it('图消息里必须有中性锚点文字 block（图在前文在后）', async () => {
    const fake = await startFakeOpenAI([oaiToolCallRound(), oaiEndRound()]);
    cleanup = fake.close;

    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
      supportsVision: true,
    });
    backend.registerTool(renderToolWithImage('render_html'));

    await consumeAll(backend.runConversation(baseInput()));

    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; content: unknown }> };
    const userImgMsg = body2.messages.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((b) => b.type === 'image_url'),
    );
    expect(userImgMsg).toBeDefined();

    const blocks = userImgMsg!.content as Array<{ type: string; text?: string }>;
    // 图在前：第一个 block 是 image_url
    expect(blocks[0].type).toBe('image_url');
    // 有一个 text block（锚点文字）
    const textBlocks = blocks.filter((b) => b.type === 'text');
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
    // 锚点文字不为空
    expect(textBlocks[0].text?.trim().length).toBeGreaterThan(0);
  });
});

// ─── ② supportsVision=false：降级占位 ───────────────────────────

describe('D2 工具图回传：supportsVision=false', () => {
  it('工具带 images + 视觉不支持 → 无 image_url，tool 回执文字含降级占位', async () => {
    const fake = await startFakeOpenAI([oaiToolCallRound(), oaiEndRound()]);
    cleanup = fake.close;

    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
      supportsVision: false,
    });
    backend.registerTool(renderToolWithImage('render_html'));

    await consumeAll(backend.runConversation(baseInput()));

    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; content: unknown }> };

    // 完全没有 image_url
    const hasImageUrl = body2.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((b) => b.type === 'image_url'),
    );
    expect(hasImageUrl).toBe(false);

    // tool 回执（role:'tool'）文字含降级占位
    const toolMsgs = body2.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
    const toolContent = toolMsgs[0].content as string;
    expect(typeof toolContent).toBe('string');
    expect(toolContent).toContain('当前模型不支持看图');
  });
});

// ─── ③ 不变量：role:'tool' content 恒为 string ──────────────────

describe('D2 不变量：role:tool content 永远是 string', () => {
  it('supportsVision=true 时，role:tool content 仍是 string，不是 array', async () => {
    const fake = await startFakeOpenAI([oaiToolCallRound(), oaiEndRound()]);
    cleanup = fake.close;

    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
      supportsVision: true,
    });
    backend.registerTool(renderToolWithImage('render_html'));

    await consumeAll(backend.runConversation(baseInput()));

    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; content: unknown }> };
    const toolMsgs = body2.messages.filter((m) => m.role === 'tool');
    for (const tm of toolMsgs) {
      expect(typeof tm.content).toBe('string');
    }
  });

  it('无图工具（images 未填）时，role:tool content 仍是 string（回归）', async () => {
    const fake = await startFakeOpenAI([oaiToolCallRound(), oaiEndRound()]);
    cleanup = fake.close;

    const backend = new OpenAICompatibleBackend({
      apiKey: 'sk',
      defaultModel: 'gpt-5',
      baseURL: fake.baseURL,
      providerType: 'openai',
      supportsVision: true,
    });
    // 普通工具，不带 images
    const plainTool: AgentTool = {
      name: 'render_html',
      description: '普通工具',
      inputSchema: { type: 'object' as const, properties: {} },
      mutatesEnvironment: false, // 纯读
      async execute() {
        return { text: '纯文字结果' };
      },
    } satisfies AgentTool;
    backend.registerTool(plainTool);

    await consumeAll(backend.runConversation(baseInput()));

    const body2 = fake.receivedBodies[1] as { messages: Array<{ role: string; content: unknown }> };
    const toolMsgs = body2.messages.filter((m) => m.role === 'tool');
    for (const tm of toolMsgs) {
      expect(typeof tm.content).toBe('string');
    }
    // 没有带 image_url 的 user 消息
    const hasImageUrl = body2.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>).some((b) => b.type === 'image_url'),
    );
    expect(hasImageUrl).toBe(false);
  });
});

// ─── ④ Anthropic adapter 消费 images（2026-07-28 起） ────────────

describe('Anthropic adapter 消费 images（2026-07-28 起：此前静默丢图，模型不知自己没看见）', () => {
  it('支持视觉的模型：图拼进 tool_result 的块数组喂回模型', async () => {
    const fake = await startFakeAnthropic([anthToolRound(), anthEndRound()]);
    cleanup = fake.close;

    const backend = new AnthropicBackend({
      apiKey: 'sk',
      defaultModel: 'claude-sonnet-4-6',
      baseURL: fake.baseURL,
      supportsVision: true,
    });
    backend.registerTool(renderToolWithImage('render_html'));

    const events = await consumeAll(backend.runConversation(baseInput()));
    // 能正常完成，result 事件到达
    expect(events.some((e) => (e as Record<string, unknown>).type === 'result')).toBe(true);

    // 带图的 tool_result：content 是 [text, image...] 块数组，图以 base64 source 原样带上
    const body2 = fake.receivedBodies[1] as {
      messages: Array<{ role: string; content: Array<{ type: string; content?: unknown }> }>;
    };
    const lastUserTurn = body2.messages[body2.messages.length - 1];
    expect(lastUserTurn.role).toBe('user');
    const toolResultBlocks = lastUserTurn.content.filter((b) => b.type === 'tool_result');
    expect(toolResultBlocks.length).toBeGreaterThanOrEqual(1);
    for (const tr of toolResultBlocks) {
      expect(Array.isArray(tr.content)).toBe(true);
      const blocks = tr.content as Array<{ type: string; source?: { type: string; media_type: string; data: string } }>;
      expect(blocks[0].type).toBe('text');
      const img = blocks.find((b) => b.type === 'image');
      expect(img?.source).toEqual({
        type: 'base64',
        media_type: 'image/png',
        data: expect.any(String),
      });
    }
  });

  it('不支持视觉的模型：不发图，改在文字末尾告知（coding plan 三家走这条，发图会每轮 400）', async () => {
    const fake = await startFakeAnthropic([anthToolRound(), anthEndRound()]);
    cleanup = fake.close;
    const backend = new AnthropicBackend({
      apiKey: 'sk',
      defaultModel: 'glm-4.7',
      baseURL: fake.baseURL,
      // 不传 supportsVision → 默认 false，与 recommendations.ts 里三家 coding plan 搭载款一致
    });
    backend.registerTool(renderToolWithImage('render_html'));

    await consumeAll(backend.runConversation(baseInput()));

    const body2 = fake.receivedBodies[1] as {
      messages: Array<{ role: string; content: Array<{ type: string; content?: unknown }> }>;
    };
    const toolResultBlocks = body2.messages[body2.messages.length - 1].content.filter(
      (b) => b.type === 'tool_result',
    );
    expect(toolResultBlocks.length).toBeGreaterThanOrEqual(1);
    for (const tr of toolResultBlocks) {
      // 纯字符串（没有 image block），且文字里明说了看不到图
      expect(typeof tr.content).toBe('string');
      expect(tr.content as string).toContain('不支持看图');
    }
  });

  it('工具不带 images 时 content 仍是纯字符串（无图路径形状零变化）', async () => {
    const fake = await startFakeAnthropic([anthToolRound(), anthEndRound()]);
    cleanup = fake.close;
    const backend = new AnthropicBackend({
      apiKey: 'sk',
      defaultModel: 'claude-sonnet-4-6',
      baseURL: fake.baseURL,
    });
    // 同名工具但不产图
    backend.registerTool({
      name: 'render_html',
      description: '不产图的工具',
      inputSchema: { type: 'object', properties: {} },
      mutatesEnvironment: false,
      execute: async () => ({ text: 'done' }),
    });

    await consumeAll(backend.runConversation(baseInput()));

    const body2 = fake.receivedBodies[1] as {
      messages: Array<{ role: string; content: Array<{ type: string; content?: unknown }> }>;
    };
    const toolResultBlocks = body2.messages[body2.messages.length - 1].content.filter(
      (b) => b.type === 'tool_result',
    );
    for (const tr of toolResultBlocks) {
      expect(typeof tr.content).toBe('string');
    }
  });
});
