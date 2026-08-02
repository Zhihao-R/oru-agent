/**
 * OpenAI 兼容协议的最小 client —— fetch + SSE 直连，零 SDK 依赖
 *
 * 覆盖：智谱 / Kimi / OpenAI / OpenRouter（任何 OpenAI Chat Completions 兼容协议）
 *
 * 始终用 streaming（stream=true）—— 非流式在大输出+reasoning 下首字节 >10min 触发 HeadersTimeout。
 * 流式每个 chunk 都重置 timeout，永远不会卡死。最后再把 chunk 聚合成 OAIChatResponse 形态返回，
 * 调用方不用关心流。
 */
import { Agent, fetch as undiciFetch, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(
  new Agent({
    headersTimeout: 600_000,
    bodyTimeout: 600_000,
    connectTimeout: 30_000,
  }),
);

export type OAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export type OAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type OAIChatResponse = {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

export async function callOpenAICompat(args: {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: OAIMessage[];
  tools?: OAITool[];
  maxTokens?: number;
  temperature?: number;
}): Promise<OAIChatResponse> {
  const url = `${args.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    max_tokens: args.maxTokens ?? 8192,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (args.temperature !== undefined) body.temperature = args.temperature;
  if (args.tools && args.tools.length > 0) {
    body.tools = args.tools;
    body.tool_choice = 'auto';
  }

  const resp = await undiciFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${args.baseURL} returned ${resp.status}: ${text.slice(0, 500)}`);
  }
  if (!resp.body) throw new Error('response has no body');

  // undici 的 ReadableStream 与 lib.dom 的 ReadableStream<Uint8Array> 泛型签名有歧义 —— cast 掉
  return await consumeStream(resp.body as unknown as ReadableStream<Uint8Array>, args.model);
}

// ─── SSE 解析 + chunk 聚合 ──────────────────────────────────

type ToolCallAccum = {
  id?: string;
  name?: string;
  argsBuf: string;
};

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): Promise<OAIChatResponse> {
  const decoder = new TextDecoder();
  let buf = '';
  let id = '';
  let contentBuf = '';
  const toolCalls: Record<number, ToolCallAccum> = {};
  let finishReason: string = 'stop';
  let usage: OAIChatResponse['usage'];

  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE 以 \n\n 分隔事件
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = event
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6));
      for (const data of dataLines) {
        if (data === '[DONE]') continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.id) id = json.id;
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string') contentBuf += delta.content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tcDelta of delta.tool_calls) {
            const i = tcDelta.index ?? 0;
            if (!toolCalls[i]) toolCalls[i] = { argsBuf: '' };
            if (tcDelta.id) toolCalls[i].id = tcDelta.id;
            if (tcDelta.function?.name) toolCalls[i].name = tcDelta.function.name;
            if (typeof tcDelta.function?.arguments === 'string') {
              toolCalls[i].argsBuf += tcDelta.function.arguments;
            }
          }
        }
      }
    }
  }

  const toolCallList = Object.keys(toolCalls)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((i) => toolCalls[i])
    .filter((t) => t.name)
    .map((t) => ({
      id: t.id ?? '',
      type: 'function' as const,
      function: { name: t.name ?? '', arguments: t.argsBuf },
    }));

  return {
    id,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: contentBuf,
          ...(toolCallList.length > 0 ? { tool_calls: toolCallList } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}
