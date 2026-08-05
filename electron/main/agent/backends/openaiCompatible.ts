/**
 * OpenAICompatibleBackend — 覆盖 openrouter / openai / zhipu / kimi / custom-openai
 *
 * 直接 fetch /v1/chat/completions（含 stream=true 的 SSE 解析），不依赖 openai SDK。
 * 避免再装一个包；自己控可见性更高。
 *
 * 要点：
 * - 流式：SSE 按 `\n\n` 切；`data: [DONE]` 结束；`data: {...}` 是 chat.completion.chunk
 * - 多 tool_calls 累积：每个 tool_call delta 带 index，按 index 拼到 toolCallsAcc[index]，
 *   .id / .function.name 偶发更新，.function.arguments 拼字符串，全部到齐后 JSON.parse
 * - round-trip：finish_reason='tool_calls' → 并发执行所有工具（Promise.all），全部回执塞回 messages 再发下一轮
 * - 工具抛错：try/catch 转 is_error=true 回执，绝不漏 tool_call_id
 * - history：通过 historyAdapter('openai-fc') 翻译；assistant 含 tool_use blocks → 单条带 tool_calls 的 assistant message；user 含 tool_result blocks → 拆成多条 role:'tool' message
 * - runOneShot：response_format: json_schema 优先；失败回退到 prompt 注入
 */
import type {
  AgentBackend,
  AgentTool,
  ConversationEvent,
  ConversationHandle,
  ConversationInput,
  ConversationUsage,
  OneShotInput,
  OneShotResult,
  ToolContext,
  ToolResult as AgentToolResult,
  ToolResultImage,
} from '@shared/agent/backend';
import { STEERING_SUPPLEMENT_PREFIX } from '@shared/agent/backend';
import { assertCurrentTurnInHistory } from './historyContract';
import { runRoundTrip, type ProtocolAdapter, type RoundResult, type ToolExecResult } from './roundTrip';
import { executeAgentTool } from '../agentTools/approvalGate';
import type { BackendProviderType, ChatMessage } from '@shared/types';
import {
  adaptHistory,
  isInferenceViewEnabled,
  type NormalizedMessage,
} from './historyAdapter';
import { readAttachmentBase64 } from '../../conversations/attachments';
import { cachedSystemSegments } from './systemCacheSplit';
import {
  DEFAULT_RETRY,
  HttpError,
  withRetry,
  readWithIdleTimeout,
} from '../util/retry';

/** 各 provider 的默认 baseURL；custom-openai 必须用户自己传 */
const DEFAULT_BASE_URL: Partial<Record<BackendProviderType, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  kimi: 'https://api.moonshot.cn/v1',
};

export function resolveOpenAICompatibleBaseURL(
  type: BackendProviderType,
  override?: string,
): string {
  if (override && override.trim().length > 0) return override.replace(/\/$/, '');
  const def = DEFAULT_BASE_URL[type];
  if (!def) {
    throw new Error(`provider type ${type} 没有默认 baseURL，必须显式提供 baseUrl`);
  }
  return def.replace(/\/$/, '');
}

// ─── OpenAI 风格 messages 形态 ─────────────────────────────────────

/**
 * v0.3：user 消息允许 array content 形态（多模态：text + image_url 块）。
 * v0.6：text part 允许带 cache_control——OpenRouter 协议扩展，透传给支持显式
 * prompt cache 的上游（Anthropic / Qwen / 等）。仅 OpenRouter 路径会注入此字段。
 */
type OAIUserContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string } };
type OAITextMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | OAIUserContentBlock[];
};
type OAIToolMessage = { role: 'tool'; tool_call_id: string; content: string };
type OAIAssistantWithCalls = {
  role: 'assistant';
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
};
type OAIMessage = OAITextMessage | OAIToolMessage | OAIAssistantWithCalls;

type OAIToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: object };
};

// ─── Backend 主体 ───────────────────────────────────────────────

export class OpenAICompatibleBackend implements AgentBackend {
  readonly backendType = 'openai-compatible' as const;
  readonly toolProtocol = 'openai-fc' as const;
  readonly modelId?: string;
  readonly providerId?: string;
  private readonly tools = new Map<string, AgentTool>();
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly baseURL: string;
  private readonly providerType: BackendProviderType;
  /** 单次回复输出 token 上限；undefined → 不下发 max_tokens，由模型默认决定（默认不限制） */
  private readonly maxOutputTokens?: number;
  /** 是否支持视觉；historyAdapter 据此决定 image block 还是占位降级 */
  private readonly supportsVision: boolean;
  /**
   * 是否在 system 段打 cache_control（仅 OpenRouter 路径生效；其他 OpenAI 兼容
   * provider 走平台隐式自动缓存，无需任何字段，此 flag 仅作 UI 事实陈述）。
   */
  private readonly supportsPromptCache: boolean;
  /** 是否在请求体里发 reasoning 字段（仅 OpenRouter 路径生效）。 */
  private readonly supportsReasoning: boolean;
  /** reasoning effort 强度（仅 OpenRouter + supportsReasoning=true 时生效） */
  private readonly reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

  constructor(opts: {
    apiKey: string;
    defaultModel: string;
    baseURL: string;
    providerType: BackendProviderType;
    modelId?: string;
    providerId?: string;
    /** 来自当前 RegisteredModel.maxOutputTokens；不传走 SDK 默认 */
    maxOutputTokens?: number;
    /** 来自当前 RegisteredModel.supportsVision；不传按 false */
    supportsVision?: boolean;
    /** 来自当前 RegisteredModel.supportsPromptCache；不传按 false */
    supportsPromptCache?: boolean;
    /** 来自当前 RegisteredModel.supportsReasoning；不传按 false */
    supportsReasoning?: boolean;
    /** 来自当前 RegisteredModel.reasoningEffort；不传按 'medium' */
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  }) {
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.baseURL = opts.baseURL;
    this.providerType = opts.providerType;
    this.modelId = opts.modelId;
    this.providerId = opts.providerId;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.supportsVision = opts.supportsVision === true;
    this.supportsPromptCache = opts.supportsPromptCache === true;
    this.supportsReasoning = opts.supportsReasoning === true;
    this.reasoningEffort = opts.reasoningEffort ?? 'medium';
  }

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  async isReady(): Promise<{ ok: boolean; hint: string }> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      return { ok: false, hint: `${this.providerType} provider 缺少 API Key——请去 Settings 填入` };
    }
    return { ok: true, hint: `已使用 ${this.providerType} (${this.baseURL})` };
  }

  runConversation(input: ConversationInput): ConversationHandle {
    return { events: this.runConversationGen(input) };
  }

  private async *runConversationGen(input: ConversationInput): AsyncGenerator<ConversationEvent> {
    // 跨 backend 契约闸：本后端不读 userMessage，当前 user 轮必须在 history 末尾（见 historyContract）。
    assertCurrentTurnInHistory(input, 'openaiCompatible');
    const model = input.model ?? this.defaultModel;
    const ctx = input.toolContext;

    // 拼装 messages：system + history（通过 adapter）
    const messages: OAIMessage[] = [];
    const systemMsg = this.buildSystemMessage(
      input.systemContext,
      input.stableSystemContext,
      input.sessionStableSystemContext,
    );
    if (systemMsg) messages.push(systemMsg);
    const oaiHistory = input.history ?? [];
    const inferenceViewEnabled = isInferenceViewEnabled();
    // 抽成闭包 buildSeedMessages——seed 段（system 之后的 history 翻译）；续发检查点整理后
    // （replaceSeedHistory）复用同一翻译，保证 seed 逐字节一致。
    const buildSeedMessages = async (h: ChatMessage[]) => {
      const { messages: normalized, savings } = adaptHistory({
        messages: h,
        targetProtocol: 'openai-fc',
        targetSupportsVision: this.supportsVision,
        attachmentLoaderFor: this.supportsVision
          ? (a) => () => readAttachmentBase64(input.agentId, input.conversationId, a)
          : undefined,
      });
      const seed: OAIMessage[] = [];
      for (const m of normalized) seed.push(...(await toOpenAIMessages(m)));
      return { seed, normalized, savings };
    };
    const seed0 = await buildSeedMessages(oaiHistory);
    input.onInferenceView?.({
      enabled: inferenceViewEnabled,
      adapterRan: true,
      savings: seed0.savings,
      wireHistory: seed0.normalized,
    });
    messages.push(...seed0.seed);

    // debug：跨多轮 round-trip 累加 usage（最终 yield result 时一次性带出去）
    // ⚠ stream_options.include_usage 是 OpenAI 2024-07 之后的扩展字段——OpenRouter / OpenAI / Zhipu 实测全支持，
    // DeepSeek / Kimi (Moonshot) 等 OpenAI-兼容 provider 实测覆盖率不全；不支持的 provider
    // 这里 usage 永远 0、sawUsage 永远 false，buildUsage 返回 undefined，调试面板对应字段显示 "—"。
    let usageInputTokens = 0;
    let usageOutputTokens = 0;
    let usageCacheReadTokens = 0;
    let usageReasoningTokens = 0;
    let usageActualModel: string | undefined;
    // 跨整次 conversation 标志：是否见过任何 usage chunk。决定 buildUsage 是否输出 extended.cacheReadTokens
    // ——区分 "真 0（命中 0）" 与 "未返回 usage（无法判断）" 两种语义。
    let sawUsage = false;

    // PR-D2：评论场景透传 disallowedTools 过滤工具集
    const denylist = new Set(input.disallowedTools ?? []);
    // 随手评点（aside）只读白名单：restrictToolsTo 存在时本回合只暴露"白名单 ∩ 已注册"。
    // 正向枚举——漏列的后果是"少个工具"，不是"多个洞"；undefined = 不收口、行为不变。
    const allowSet = input.restrictToolsTo ? new Set(input.restrictToolsTo) : null;
    const toolDefs: OAIToolDef[] = Array.from(this.tools.values())
      .filter((t) => !denylist.has(t.name) && (!allowSet || allowSet.has(t.name)))
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    // 执行分发面与声明面同源：模型幻觉出「未声明但已注册」的工具名时不得直通 this.tools
    // 执行——白名单/denylist 回合下这是收口的执行面（声明面过滤只挡「看见」，挡不住「点名」）。
    const declaredToolNames = new Set(toolDefs.map((t) => t.function.name));

    // 工具 round-trip：循环 / 工具并发 / steering 边界 / usage 累加抽到共享内核 runRoundTrip（D1）；
    // 本 backend 只提供 OpenAIRoundTripAdapter——SSE 解析 / withRetry / wire 落位 / usage 口径 / 事件形状全在它里。
    const adapter = new OpenAIRoundTripAdapter({
      baseURL: this.baseURL,
      apiKey: this.apiKey,
      model,
      // undefined → streamOnce 不下发 max_tokens，让模型用自身默认输出上限（见方案 A）
      maxTokens: this.maxOutputTokens,
      messages,
      hasSystem: !!systemMsg,
      buildSeed: async (h) => (await buildSeedMessages(h)).seed,
      toolDefs,
      disableReasoning: input.disableReasoning,
      orReasoning: (d) => this.orReasoning(d),
      orHeaders: () => this.orHeaders(),
      computeUsage: (i, o, cr, rt, m, s) => this.buildUsage(i, o, cr, rt, m, s),
    });
    yield* runRoundTrip(
      adapter,
      input,
      (name, toolInput) => this.executeToolSafe(name, toolInput, ctx),
      declaredToolNames,
    );
  }

  async runOneShot(input: OneShotInput, signal?: AbortSignal): Promise<OneShotResult> {
    // 防搜索摘要循环：runOneShot **永不**带 tools——下面的 body 不包含 tools 字段。
    // 这是 web_fetch 长摘要 summarizer 的安全前提：summarizer 调 runOneShot 时模型看不到任何工具，
    // 不可能再次触发 web_fetch。详见 docs/tech/2026-05-07-web-search-tech-design.md §8.2。
    const model = input.model ?? this.defaultModel;
    const messages: OAIMessage[] = [];
    // 一次性短调用（summarizer / dream）走纯 string。cacheSystem（召回挑选器等 systemContext 短时
    // 复用场景）→ system 走带 cache_control 的 parts，让 OR 透传给上游显式缓存（隐式前缀缓存对 Claude
    // 不可靠，需显式 breakpoint）。
    if (input.systemContext && input.systemContext.trim().length > 0) {
      messages.push(
        input.cacheSystem
          ? {
              role: 'system',
              content: [
                { type: 'text', text: input.systemContext, cache_control: { type: 'ephemeral' } },
              ],
            }
          : { role: 'system', content: input.systemContext },
      );
    }
    // 带图（aside 窗口截图等）→ user content 升级为多模态 array（图在前、文在后，
    // 与主对话路径 toOpenAIMessages 的混合形态一致）；无图保持纯字符串，请求形状零变化
    const userContent: string | OAIUserContentBlock[] =
      input.images && input.images.length > 0
        ? [
            ...input.images.map(
              (img): OAIUserContentBlock => ({
                type: 'image_url',
                image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
              }),
            ),
            { type: 'text', text: input.prompt },
          ]
        : input.prompt;
    messages.push({ role: 'user', content: userContent });

    // schema 注入文案接到 user content 尾部——纯字符串直接拼接（与改动前逐字节一致）；
    // 多模态 array 追加一个 text 块
    const appendText = (
      content: string | OAIUserContentBlock[],
      suffix: string,
    ): string | OAIUserContentBlock[] =>
      typeof content === 'string' ? content + suffix : [...content, { type: 'text', text: suffix }];

    // 优先用 response_format: json_schema；失败时回退到 prompt 注入策略再调一次
    const tryOnce = async (useResponseFormat: boolean): Promise<OneShotResult> => {
      const body: Record<string, unknown> = {
        model,
        messages: useResponseFormat
          ? messages
          : [...messages].map((m, i) =>
              i === messages.length - 1 && input.outputSchema
                ? {
                    ...m,
                    content: appendText(
                      (m as OAITextMessage).content,
                      `\n\n你必须以一段合法 JSON 返回，符合下面这个 schema（不要加 markdown 围栏，不要解释，只输出 JSON）：\n` +
                        JSON.stringify(input.outputSchema, null, 2),
                    ),
                  }
                : m,
            ),
      };
      // 方案 A：未显式配置 maxOutputTokens 时不发 max_tokens，让模型用默认输出上限——
      // 既不把回复悄悄钳到 8192，也不撞 qwen 等强制思考模型的 thinking_budget 校验。
      if (this.maxOutputTokens != null) body.max_tokens = this.maxOutputTokens;
      if (useResponseFormat && input.outputSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'output',
            schema: input.outputSchema,
            strict: false,
          },
        };
      }
      Object.assign(body, this.orReasoning(input.disableReasoning));
      const resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...this.orHeaders(),
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        const errText = await safeReadText(resp);
        throw new Error(`${this.providerType} HTTP ${resp.status}: ${errText.slice(0, 500)}`);
      }
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          completion_tokens_details?: { reasoning_tokens?: number };
        };
      };
      const text = json.choices?.[0]?.message?.content ?? '';
      const u = json.usage;
      // 与 conversation 路径同口径：复用 buildUsage 填 extended.cacheReadTokens/reasoningTokens，
      // 否则 oneShot 的 token 比 conversation 少 cache/reasoning 两维。
      const usage = this.buildUsage(
        u?.prompt_tokens ?? 0,
        u?.completion_tokens ?? 0,
        u?.prompt_tokens_details?.cached_tokens ?? 0,
        u?.completion_tokens_details?.reasoning_tokens ?? 0,
        model,
        Boolean(u),
      );
      return { text: text.trim(), usage };
    };

    if (input.outputSchema) {
      let first: OneShotResult | null = null;
      try {
        first = await tryOnce(true);
      } catch {
        // 模型不支持 json_schema（HTTP 报错）→ 回退
      }
      // 带 schema 时空正文永远不是合法输出（schema 要求一个 JSON 对象）——部分模型
      // （如 hy3-preview）对 json_schema 静默不兼容：HTTP 200、只产 reasoning 不产正文。
      // 视同不支持，回退 prompt 注入；回退仍空则原样返回空，由调用方判故障。
      if (first && first.text !== '') return first;
      const second = await tryOnce(false);
      // 首次调用的 token 真实消耗了——合并计入，不漏账
      return first ? { ...second, usage: mergeOneShotUsage(first.usage, second.usage) } : second;
    }
    return await tryOnce(false);
  }

  /** debug：从累加的原始字段拼成 ConversationUsage（仅在最终 yield result 时用一次） */
  private buildUsage(
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    reasoningTokens: number,
    actualModel: string | undefined,
    sawUsage: boolean,
  ): ConversationUsage | undefined {
    if (inputTokens === 0 && outputTokens === 0 && !actualModel) return undefined;
    const extended: Record<string, unknown> = {};
    // 见过 usage 才输出（即使为 0）——UI 据此区分 "真未命中/未思考" 与 "未返回 usage"
    if (sawUsage) extended.cacheReadTokens = cacheReadTokens;
    if (sawUsage) extended.reasoningTokens = reasoningTokens;
    return {
      inputTokens: inputTokens || undefined,
      outputTokens: outputTokens || undefined,
      actualModel,
      extended: Object.keys(extended).length > 0 ? extended : undefined,
    };
  }

  /** OR 推荐带 referer/title 便于他们识别和 rank；其他 provider 不带。 */
  private orHeaders(): Record<string, string> {
    return this.providerType === 'openrouter'
      ? { 'HTTP-Referer': 'https://oru.local', 'X-Title': 'Oru' }
      : {};
  }

  /**
   * OR 统一 reasoning 字段：effort 由 OR 翻译成各上游原生形态。
   * 仅 OR 路径生效；其他 OpenAI 兼容 provider 不通过此字段控制思考模式
   * （OpenAI o 系列走自己 SDK 字段；Anthropic 直连走 AnthropicBackend）。
   *
   * disable=true 时强制 enabled:false——hy3-preview 这类"OR 上游本来就是 reasoning 模型、
   * Oru 这边 supportsReasoning=false 也压不住"的场景，runOneShot 显式关掉省 1500+ tokens。
   * exclude:true 不行（上游仍 think），effort:low 也不行（hy3 不吃），实测 enabled:false 才真灭。
   */
  private orReasoning(disable?: boolean): { reasoning?: { effort: string } | { enabled: false } } {
    if (this.providerType !== 'openrouter') return {};
    if (disable) return { reasoning: { enabled: false } };
    if (!this.supportsReasoning) return {};
    return { reasoning: { effort: this.reasoningEffort } };
  }

  /**
   * 构造 system message——OR + supportsPromptCache 时按缓存段拆分，每个 cached 段打一个
   * cache_control:{type:'ephemeral'} breakpoint 让 OR 透传给上游显式 cache。
   * 两层缓存（与 anthropic 同语义）：传 sessionStable 时切出 [stable | mid(能力+快照) | dynamic]——
   * 两个 breakpoint 让主对话缓存快照、同时保留独立的 stable 段供子 agent 复用。
   * 不传 sessionStable（子 agent 路径）退回单层，行为不变。
   * 其他情形整段 string；上游隐式缓存按 token 前缀自动命中。
   */
  private buildSystemMessage(
    full: string | undefined,
    stable: string | undefined,
    sessionStable?: string,
  ): OAIMessage | undefined {
    if (!full?.trim()) return undefined;
    const useCache = this.providerType === 'openrouter' && this.supportsPromptCache;
    if (!useCache) return { role: 'system', content: full };
    const segs = cachedSystemSegments(full, stable, sessionStable);
    // 无可缓存段（只有一段未缓存）→ 退回纯字符串
    if (segs.length === 1 && !segs[0].cached) return { role: 'system', content: full };
    const parts: OAIUserContentBlock[] = segs.map((seg) =>
      seg.cached
        ? { type: 'text', text: seg.text, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: seg.text },
    );
    return { role: 'system', content: parts };
  }

  private async executeToolSafe(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext | undefined,
  ): Promise<{ text: string; isError: boolean; structured?: Record<string, unknown>; images?: ToolResultImage[] }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { text: `未知工具：${name}`, isError: true };
    }
    if (!ctx) {
      return { text: `工具 ${name} 缺少 ToolContext，无法执行`, isError: true };
    }
    try {
      const result: AgentToolResult = await executeAgentTool(tool, input, ctx);
      const hasImages = result.images && result.images.length > 0;
      if (hasImages && this.supportsVision) {
        // 视觉模型：原样透出图，交 appendToolResults 聚合成 user 图消息
        return {
          text: result.text,
          isError: result.isError ?? false,
          structured: result.structured,
          images: result.images,
        };
      }
      if (hasImages && !this.supportsVision) {
        // 非视觉模型：丢弃图，在文字末尾追加降级占位，让模型知道自己看不到、不臆断
        return {
          text: `${result.text}\n[本页截图已生成，但当前模型不支持看图，无法据图自检]`,
          isError: result.isError ?? false,
          structured: result.structured,
        };
      }
      // 无图：行为零变化
      return {
        text: result.text,
        isError: result.isError ?? false,
        structured: result.structured,
      };
    } catch (e) {
      return {
        text: `工具 ${name} 抛错：${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────

/** 空正文回退重试时合并两次调用的 usage——数值维度相加，model 取后一次 */
function mergeOneShotUsage(
  a: ConversationUsage | undefined,
  b: ConversationUsage | undefined,
): ConversationUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const addOpt = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const extKeys = new Set([...Object.keys(a.extended ?? {}), ...Object.keys(b.extended ?? {})]);
  const extended: Record<string, unknown> = {};
  for (const k of extKeys) {
    const av = a.extended?.[k];
    const bv = b.extended?.[k];
    extended[k] =
      typeof av === 'number' || typeof bv === 'number'
        ? (typeof av === 'number' ? av : 0) + (typeof bv === 'number' ? bv : 0)
        : (bv ?? av);
  }
  return {
    inputTokens: addOpt(a.inputTokens, b.inputTokens),
    outputTokens: addOpt(a.outputTokens, b.outputTokens),
    actualModel: b.actualModel ?? a.actualModel,
    extended: extKeys.size > 0 ? extended : undefined,
  };
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

/** 解析 OpenAI-compat 风格的错误 body 拿出可读 message。
 *  常见形态：`{"error":{"message":"..."}}`、`{"message":"..."}`、纯文本。 */
function extractBodyMessage(rawBody: string): string | undefined {
  if (!rawBody) return undefined;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object') {
      const o = parsed as Record<string, unknown>;
      if (typeof o.message === 'string') return o.message;
      const err = o.error;
      if (err && typeof err === 'object') {
        const m = (err as Record<string, unknown>).message;
        if (typeof m === 'string') return m;
      }
      if (typeof err === 'string') return err;
    }
  } catch {
    // 非 JSON，落到下面截 raw
  }
  return rawBody.slice(0, 200);
}

/** 把 NormalizedMessage 翻译成 OpenAI messages（一条 normalized 可能拆成多条） */
async function toOpenAIMessages(m: NormalizedMessage): Promise<OAIMessage[]> {
  if (m.role === 'user') {
    // user 消息可能含 text + image + tool_result blocks
    const out: OAIMessage[] = [];
    const textBlocks = m.blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
    const imageBlocks = m.blocks.filter(
      (b): b is { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; filename: string; load: () => Promise<string> } =>
        b.type === 'image',
    );
    const toolResultBlocks = m.blocks.filter(
      (b): b is { type: 'tool_result'; toolUseId: string; content: string; isError: boolean } =>
        b.type === 'tool_result',
    );
    // tool_result 优先输出（它们关联上一条 assistant 的 tool_calls）
    for (const tr of toolResultBlocks) {
      out.push({
        role: 'tool',
        tool_call_id: tr.toolUseId,
        content: tr.isError ? `[error] ${tr.content}` : tr.content,
      });
    }
    if (imageBlocks.length > 0 || textBlocks.length > 0) {
      if (imageBlocks.length === 0) {
        // 纯文字走 string content（保持向后兼容/省字节）
        out.push({
          role: 'user',
          content: textBlocks.map((b) => b.text).join('\n\n'),
        });
      } else {
        // 混合：array content，图在前，文在后
        const blocks: OAIUserContentBlock[] = [];
        const failedFilenames: string[] = [];
        for (const ib of imageBlocks) {
          // 容错：load() 失败时把这张图转成"加载失败"占位，避免整个请求崩溃
          // （例如 conv.clear 与 runChat race 导致 ENOENT）
          // invariant: adapter 输出的 image block 必含 load（attachmentLoaderFor 注入）；
          // load 在类型上设可选是给落盘/跨进程场景（v0.5 wireHistory），运行时一定有
          try {
            const base64 = await ib.load!();
            blocks.push({
              type: 'image_url',
              image_url: { url: `data:${ib.mediaType};base64,${base64}` },
            });
          } catch {
            failedFilenames.push(ib.filename);
          }
        }
        const textParts: string[] = [];
        if (failedFilenames.length > 0) {
          textParts.push(failedFilenames.map((f) => `[图片加载失败：${f}]`).join(' '));
        }
        if (textBlocks.length > 0) {
          textParts.push(textBlocks.map((b) => b.text).join('\n\n'));
        }
        if (textParts.length > 0) {
          blocks.push({ type: 'text', text: textParts.join('\n') });
        }
        out.push({ role: 'user', content: blocks });
      }
    }
    return out;
  }
  // assistant
  const textBlocks = m.blocks.filter((b): b is { type: 'text'; text: string } => b.type === 'text');
  const toolUseBlocks = m.blocks.filter(
    (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
      b.type === 'tool_use',
  );
  if (toolUseBlocks.length > 0) {
    return [
      {
        role: 'assistant',
        content: textBlocks.length > 0 ? textBlocks.map((b) => b.text).join('\n\n') : null,
        tool_calls: toolUseBlocks.map((tu) => ({
          id: tu.id,
          type: 'function' as const,
          function: { name: tu.name, arguments: JSON.stringify(tu.input) },
        })),
      },
    ];
  }
  if (textBlocks.length > 0) {
    return [{ role: 'assistant', content: textBlocks.map((b) => b.text).join('\n\n') }];
  }
  return [];
}

/**
 * OpenAI 兼容协议适配器（D1）——把 SSE 解析 / withRetry / wire 落位 / usage 口径 / per-call 事件形状
 * 喂给共享内核 runRoundTrip。控制流（循环 / 工具并发 / steering 边界）全在内核。
 */
class OpenAIRoundTripAdapter implements ProtocolAdapter {
  private usageInputTokens = 0;
  private usageOutputTokens = 0;
  private usageCacheReadTokens = 0;
  private usageReasoningTokens = 0;
  private usageActualModel: string | undefined;
  private sawUsage = false;

  /** seed 段边界：messages[0..seedLen) 是 seed（含 system），其后是本回合 in-flight。 */
  private seedLen: number;

  constructor(
    private readonly d: {
      baseURL: string;
      apiKey: string;
      model: string;
      maxTokens?: number;
      messages: OAIMessage[];
      /** seed 段是否以 system 消息打头（messages[0]）——replaceSeedHistory 保留原位。 */
      hasSystem: boolean;
      /** 用整理后的 history 重译 seed 段的 history 部分（不含 system）。 */
      buildSeed: (history: ChatMessage[]) => Promise<OAIMessage[]>;
      toolDefs: OAIToolDef[];
      disableReasoning?: boolean;
      orReasoning: (disable?: boolean) => { reasoning?: { effort: string } | { enabled: false } };
      orHeaders: () => Record<string, string>;
      computeUsage: (
        i: number,
        o: number,
        cr: number,
        rt: number,
        m: string | undefined,
        s: boolean,
      ) => ConversationUsage | undefined;
    },
  ) {
    this.seedLen = d.messages.length;
  }

  /**
   * S16 G66 续发检查点：用整理后的 history 重建 seed 段（system 保留原位 messages[0]），
   * 本回合 in-flight 逐字节保留其后。OpenAI 允许相邻同角色，无 coalesce 边界问题。
   */
  async replaceSeedHistory(history: ChatMessage[]): Promise<void> {
    const inflight = this.d.messages.slice(this.seedLen);
    const systemPrefix = this.d.hasSystem ? this.d.messages.slice(0, 1) : [];
    const newSeedHistory = await this.d.buildSeed(history);
    this.d.messages = [...systemPrefix, ...newSeedHistory, ...inflight];
    this.seedLen = systemPrefix.length + newSeedHistory.length;
  }

  async *streamOnce(signal: AbortSignal): AsyncGenerator<ConversationEvent, RoundResult> {
    const body: Record<string, unknown> = {
      model: this.d.model,
      messages: this.d.messages,
      stream: true,
      // 让 streaming 末尾 chunk 返回 usage（OpenAI / 大多数 OpenAI-兼容 provider 支持）
      stream_options: { include_usage: true },
    };
    // 方案 A：maxTokens 显式配置才下发；undefined → 不发 max_tokens，模型默认输出上限。
    if (this.d.maxTokens != null) body.max_tokens = this.d.maxTokens;
    if (this.d.toolDefs.length > 0) body.tools = this.d.toolDefs;
    Object.assign(body, this.d.orReasoning(this.d.disableReasoning));

    // 通过 withRetry 包一层：自动 5 次重试 5xx/429/网络错；
    // 流式开始后（resp.ok 拿到后）走单独的 idle timeout 检测半死连接。
    let resp: Response | undefined;
    for await (const ev of withRetry(
      (innerSignal) =>
        fetch(`${this.d.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.d.apiKey}`,
            ...this.d.orHeaders(),
          },
          body: JSON.stringify(body),
          signal: innerSignal,
        }),
      DEFAULT_RETRY,
      signal,
    )) {
      if (ev.kind === 'retrying') {
        yield { type: 'retrying', attempt: ev.attempt, maxRetries: ev.maxRetries };
      } else {
        resp = ev.resp;
      }
    }
    if (!resp) throw new Error('withRetry did not yield a response');

    if (!resp.ok) {
      const errText = await safeReadText(resp);
      throw new HttpError(resp.status, extractBodyMessage(errText), errText);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('response body has no reader');

    let textContent = '';
    const toolCallsAcc: Array<{ id: string; name: string; argsBuf: string }> = [];
    let finishReason: string | null = null;
    // reasoning（思考通道）地基：只识别、不产 assistant_text（不展示）。推理模型可能
    // 「只思考不产正文」（hy3 前科）——这个标志经 RoundResult → result.sawReasoning 带出，
    // 供空产出报错文案区分「思考了但没给出回答」与「压根没响应」。
    let sawReasoning = false;

    // 本次 stream（即本次 LLM 调用）的 usage——结束时 yield llm_usage 给 debug
    let perCallInputTokens = 0;
    let perCallOutputTokens = 0;
    let perCallCacheReadTokens = 0;
    let perCallReasoningTokens = 0;
    let perCallSawUsage = false;

    const decoder = new TextDecoder();
    let buffer = '';

    readLoop: for await (const chunk of readWithIdleTimeout(
      reader,
      DEFAULT_RETRY.idleTimeoutMs,
      // 注意：传**原始** abortController.signal，不是 withRetry 内部的 composed signal
      // ——后者带了 header 阶段的 600s timeout，流式期不应受它影响。
      signal,
    )) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break readLoop;
          if (data.length === 0) continue;
          let ev: {
            model?: string;
            choices?: Array<{
              delta?: {
                content?: string;
                /** 思考通道两种字段形态：OpenRouter 归一为 reasoning；DeepSeek 原生为 reasoning_content */
                reasoning?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              completion_tokens_details?: { reasoning_tokens?: number };
            };
          };
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          // debug：抓 usage（最后一个 chunk 通常 choices=[] 但带 usage）
          // typeof 守卫：某些 provider 历史上把整数序列化成字符串过，纯 ?? 0 会让字符串
          // 进入 += 触发字符串拼接污染整个累加器。
          if (ev.usage) {
            const inT = typeof ev.usage.prompt_tokens === 'number' ? ev.usage.prompt_tokens : 0;
            const outT = typeof ev.usage.completion_tokens === 'number' ? ev.usage.completion_tokens : 0;
            const cachedRaw = ev.usage.prompt_tokens_details?.cached_tokens;
            const cachedT = typeof cachedRaw === 'number' ? cachedRaw : 0;
            const reasoningRaw = ev.usage.completion_tokens_details?.reasoning_tokens;
            const reasoningT = typeof reasoningRaw === 'number' ? reasoningRaw : 0;
            this.usageInputTokens += inT;
            this.usageOutputTokens += outT;
            this.usageCacheReadTokens += cachedT;
            this.usageReasoningTokens += reasoningT;
            perCallInputTokens += inT;
            perCallOutputTokens += outT;
            perCallCacheReadTokens += cachedT;
            perCallReasoningTokens += reasoningT;
            this.sawUsage = true;
            perCallSawUsage = true;
          }
          if (ev.model) this.usageActualModel = ev.model;
          const choice = ev.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content) {
            textContent += delta.content;
            yield { type: 'assistant_text', text: delta.content };
          }
          // 思考通道只置标志不产事件（地基不展示）。truthy + trim 双重排除：OpenRouter 会在
          // content delta 里带 reasoning: null、部分 provider 首帧发纯空白占位——都不算「思考过」
          if (delta?.reasoning?.trim() || delta?.reasoning_content?.trim()) sawReasoning = true;
          if (delta?.tool_calls) {
            for (const tcDelta of delta.tool_calls) {
              const i = tcDelta.index;
              if (!toolCallsAcc[i]) {
                toolCallsAcc[i] = { id: '', name: '', argsBuf: '' };
              }
              if (tcDelta.id) toolCallsAcc[i].id = tcDelta.id;
              if (tcDelta.function?.name) toolCallsAcc[i].name = tcDelta.function.name;
              if (tcDelta.function?.arguments) toolCallsAcc[i].argsBuf += tcDelta.function.arguments;
            }
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    }

    // 本次 LLM stream 结束 —— 把单次 usage emit 给 debug（derive 端绑到 llm_call_done.payload）
    // 注：不支持 include_usage 的 provider 这里 perCallSawUsage 为 false，导致 cacheReadTokens/extended 不带；
    //     derive / UI 区分 "0（真未命中）" 与 "undefined（无 usage）"。
    yield {
      type: 'llm_usage',
      inputTokens: perCallInputTokens,
      outputTokens: perCallOutputTokens,
      cacheReadTokens: perCallSawUsage ? perCallCacheReadTokens : undefined,
      extended: perCallSawUsage ? { reasoningTokens: perCallReasoningTokens } : undefined,
      finishReason: finishReason ?? undefined,
    };

    // 把本轮 assistant message 加到 messages（用于下一轮 round-trip 上下文）
    if (toolCallsAcc.length > 0) {
      const assistantMsg: OAIAssistantWithCalls = {
        role: 'assistant',
        content: textContent.length > 0 ? textContent : null,
        tool_calls: toolCallsAcc.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.argsBuf.length > 0 ? tc.argsBuf : '{}' },
        })),
      };
      this.d.messages.push(assistantMsg);
    } else if (textContent.length > 0) {
      this.d.messages.push({ role: 'assistant', content: textContent });
    }

    if (finishReason !== 'tool_calls') {
      return { toolCalls: [], isToolCall: false, finalText: textContent, sawReasoning };
    }

    // 解析每个 tool 的参数（execute 前需要先得到 input）
    const parsedTools = toolCallsAcc.map((tc) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = tc.argsBuf.length > 0 ? (JSON.parse(tc.argsBuf) as Record<string, unknown>) : {};
      } catch {
        // 参数 JSON 损坏 → 工具会自己报错
      }
      return { id: tc.id, name: tc.name, input: parsed };
    });

    // ⚠ 工具事件时序（debug 模块要求）：先**批量** yield 所有 tool_use（execute 之前，
    // 让 debug FSM 拿到正确的 tool_call_start 时间戳）。execute / tool_result 由内核负责。
    for (const p of parsedTools) {
      yield { type: 'tool_use', id: p.id, name: p.name, input: p.input };
    }
    return { toolCalls: parsedTools, isToolCall: true, finalText: textContent, sawReasoning };
  }

  appendToolResults(
    results: Array<{ id: string; name: string } & ToolExecResult>,
    steeringTexts: string[],
    noticeTexts: string[],
  ): void {
    // 所有 tool 回执塞回 messages；content 恒为纯字符串（错误前缀 [error] 让 LLM 一眼识别）。
    // ⚠ 绝不把 image_url 塞进 role:'tool' content——OpenAI 协议 tool 消息只接受字符串；
    //   图像单独起一条 role:'user' 消息（见下方 D2 图消息插入）。
    for (const r of results) {
      this.d.messages.push({
        role: 'tool',
        tool_call_id: r.id,
        content: r.isError ? `[error] ${r.text}` : r.text,
      });
    }

    // D2：工具回执图回传——把本批带图的 result 的图聚合成一条 role:'user' 图消息，
    // 插在全部 tool 回执之后、steering 之前（满足"每个 tool_call 配 tool 回执"约束）。
    // 锚点文字在图之后——图在前让模型视觉扫描先命中截图，文字作上下文说明。
    const imageBlocks: OAIUserContentBlock[] = [];
    for (const r of results) {
      if (r.images && r.images.length > 0) {
        for (const img of r.images) {
          imageBlocks.push({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
          });
        }
      }
    }
    if (imageBlocks.length > 0) {
      const anchorBlock: OAIUserContentBlock = {
        type: 'text',
        text: '以上是上述工具刚渲染的页面截图，请据图判断结果。',
      };
      this.d.messages.push({ role: 'user', content: [...imageBlocks, anchorBlock] });
    }

    // Steering：动作边界 drain——openai 的 tool 消息是纯字符串塞不进搭车，故另起一条 user 消息
    // 承载被读入的「将生效」文本（须在全部 tool 回执之后，满足"每个 tool_call 配 tool 回执"）。
    if (steeringTexts.length > 0) {
      this.d.messages.push({ role: 'user', content: `${STEERING_SUPPLEMENT_PREFIX}\n${steeringTexts.join('\n\n')}` });
    }
    // 边界系统通知（后台终态）：纯文本 user 消息，不套用户补话前缀（它是系统记，不是用户说的）
    if (noticeTexts.length > 0) {
      this.d.messages.push({ role: 'user', content: noticeTexts.join('\n\n') });
    }
  }

  buildResultUsage(): ConversationUsage | undefined {
    return this.d.computeUsage(
      this.usageInputTokens,
      this.usageOutputTokens,
      this.usageCacheReadTokens,
      this.usageReasoningTokens,
      this.usageActualModel,
      this.sawUsage,
    );
  }
}
