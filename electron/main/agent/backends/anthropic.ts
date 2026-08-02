/**
 * AnthropicBackend — 直连 Anthropic Messages API
 *
 * 用 @anthropic-ai/sdk 直接调用，独立于 Claude Agent SDK。
 *
 * 职责：
 * - 把 history（ChatMessage[]）通过 historyAdapter 翻译成 Anthropic messages 形态
 * - 把 AgentTool[] 翻译成 Anthropic tools 字段（input_schema 直接喂 JSON Schema）
 * - 流式 + 工具 round-trip：自己 while 循环到无 tool_use stop_reason
 * - tool_use 块累积 partial_json delta，content_block_stop 时 JSON.parse
 * - 落盘 ChatMessage 时打 backendType='anthropic' / toolProtocol='anthropic-native'（runner 看 backend.toolProtocol）
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock as AnthMessageContentBlock,
  ContentBlockParam as AnthContentBlockParam,
  MessageParam as AnthMessageParam,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
// AnthMessageContentBlock 用于 runOneShot 的非流式响应解析
type _AnthBlockHint = AnthMessageContentBlock;
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
} from '@shared/agent/backend';
import { STEERING_SUPPLEMENT_PREFIX } from '@shared/agent/backend';
import type { ChatMessage } from '@shared/types';
import { assertCurrentTurnInHistory } from './historyContract';
import { runRoundTrip, type ProtocolAdapter, type RoundResult, type ToolExecResult } from './roundTrip';
import { executeAgentTool } from '../agentTools/approvalGate';
import {
  adaptHistory,
  isInferenceViewEnabled,
  type AssistantBlock,
  type NormalizedMessage,
} from './historyAdapter';
import { readAttachmentBase64 } from '../../conversations/attachments';
import { cachedSystemSegments } from './systemCacheSplit';
import { retryStreamStart, DEFAULT_RETRY } from '../util/retry';

const DEFAULT_MAX_TOKENS = 8192;

/**
 * 直连 Anthropic 的「首事件前可重试」判定（S25 G09）——网络层错误、408/409/429、5xx。
 * 与 openaiCompatible 的 shouldRetry 同一口径，只是作用在 SDK 抛出的异常类型上（SDK 已抽掉 Response）。
 */
function isRetryableAnthropicError(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true; // 连接失败 / 连接超时（含 APIConnectionTimeoutError 子类）
  if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
    const s = e.status;
    return s === 408 || s === 409 || s === 429 || s >= 500;
  }
  return false;
}

/** content（string | block[]）归一成 block 数组，便于合并。 */
function asContentBlocks(content: AnthMessageParam['content']): AnthContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
}

/**
 * 合并相邻同角色消息——Anthropic 拒绝连续同角色。导出供单测。
 * 不改入参；相邻同角色把 content 拼成一个 block 数组（reassign 新数组，不 mutate 原 content）。
 */
export function coalesceAdjacentSameRole(messages: AnthMessageParam[]): AnthMessageParam[] {
  const out: AnthMessageParam[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = [...asContentBlocks(prev.content), ...asContentBlocks(m.content)];
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export class AnthropicBackend implements AgentBackend {
  readonly backendType = 'anthropic' as const;
  readonly toolProtocol = 'anthropic-native' as const;
  readonly modelId?: string;
  readonly providerId?: string;
  private readonly tools = new Map<string, AgentTool>();
  private readonly apiKey: string;
  /** Bearer 鉴权令牌（第三方 coding plan 的 Anthropic 兼容端点用 Authorization: Bearer）；
   *  设了就发 authToken、不发 apiKey，二选一。见 providerPresets 的 authMode。 */
  private readonly authToken?: string;
  private readonly defaultModel: string;
  private readonly baseURL?: string;
  /** 单次回复输出 token 上限；undefined → 用 DEFAULT_MAX_TOKENS */
  private readonly maxOutputTokens?: number;
  /** 是否允许给 system 段加 cache_control（不开 → 整段降级为字符串形态） */
  private readonly supportsPromptCache: boolean;
  /** 是否支持视觉（图片输入）；historyAdapter 据此决定 image block 还是占位文字 */
  private readonly supportsVision: boolean;

  constructor(opts: {
    apiKey: string;
    defaultModel: string;
    baseURL?: string;
    modelId?: string;
    providerId?: string;
    /** 来自当前 RegisteredModel.maxOutputTokens；不传走 SDK 默认 8192 */
    maxOutputTokens?: number;
    /** 来自当前 RegisteredModel.supportsPromptCache；不传按 false（保守不开 cache） */
    supportsPromptCache?: boolean;
    /** 来自当前 RegisteredModel.supportsVision；不传按 false */
    supportsVision?: boolean;
    /** Bearer 令牌；设了则 SDK 发 Authorization: Bearer、不发 x-api-key（coding plan 端商用） */
    authToken?: string;
  }) {
    this.apiKey = opts.apiKey;
    this.authToken = opts.authToken;
    this.defaultModel = opts.defaultModel;
    this.baseURL = opts.baseURL;
    this.modelId = opts.modelId;
    this.providerId = opts.providerId;
    this.maxOutputTokens = opts.maxOutputTokens;
    this.supportsPromptCache = opts.supportsPromptCache ?? false;
    this.supportsVision = opts.supportsVision === true;
  }

  /** SDK 鉴权选项：有 authToken 走 Bearer，否则走 x-api-key——二选一，不同时发。 */
  private clientAuth(): { apiKey: string } | { authToken: string } {
    return this.authToken ? { authToken: this.authToken } : { apiKey: this.apiKey };
  }

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  async isReady(): Promise<{ ok: boolean; hint: string }> {
    // 凭证二选一：apiKey（x-api-key）或 authToken（Bearer，coding plan）——任一非空即就绪。
    const credential = this.authToken ?? this.apiKey;
    if (!credential || credential.trim().length === 0) {
      return { ok: false, hint: 'Anthropic provider 缺少 API Key——请去 Settings 填入' };
    }
    return { ok: true, hint: '已使用 Anthropic 直连' };
  }

  runConversation(input: ConversationInput): ConversationHandle {
    const events = this.runConversationGen(input);
    return { events };
  }

  private async *runConversationGen(input: ConversationInput): AsyncGenerator<ConversationEvent> {
    // 跨 backend 契约闸：本后端不读 userMessage，当前 user 轮必须在 history 末尾（见 historyContract）。
    assertCurrentTurnInHistory(input, 'anthropic');
    const client = new Anthropic({
      ...this.clientAuth(),
      baseURL: this.baseURL,
      // S25 G09：接管重试——SDK 内置重试对上层不可见、发不出「正在重试」提示。改由 streamOnce
      // 的 retryStreamStart 在首事件前重试并 yield retrying 事件，与 openaiCompatible 统一可见。
      maxRetries: 0,
    });
    const model = input.model ?? this.defaultModel;
    const ctx = input.toolContext;

    // 拼装 seed 段 messages：先把 history 通过 historyAdapter 翻译，再 coalesce 相邻同角色。
    // 抽成闭包 buildSeed——续发检查点整理后（replaceSeedHistory）复用同一翻译，保证 seed 逐字节一致。
    const history = input.history ?? [];
    const inferenceViewEnabled = isInferenceViewEnabled();
    const buildSeed = async (h: ChatMessage[]) => {
      const { messages: normalized, savings } = adaptHistory({
        messages: h,
        targetProtocol: 'anthropic-native',
        targetSupportsVision: this.supportsVision,
        attachmentLoaderFor: this.supportsVision
          ? (a) => () => readAttachmentBase64(input.agentId, input.conversationId, a)
          : undefined,
      });
      // 合并相邻同角色——Anthropic 拒绝连续同角色消息（steering 落盘的独立 user 与起回合 user 相邻等）。
      const coalesced = coalesceAdjacentSameRole(
        await Promise.all(normalized.map(toAnthropicMessageParam)),
      );
      return { coalesced, savings, normalized };
    };
    const seed0 = await buildSeed(history);
    input.onInferenceView?.({
      enabled: inferenceViewEnabled,
      adapterRan: true,
      savings: seed0.savings,
      wireHistory: seed0.normalized,
    });
    const messages = seed0.coalesced;
    // 注：history 已经包含本轮 user 消息（runner.ts 在 chat.send 时先 appendMessage 再起 streaming）
    // 所以这里不再追加 input.userMessage

    // PR-D2：评论场景透传 disallowedTools 过滤工具集（deny propose_action / commit_changes 等）
    const denylist = new Set(input.disallowedTools ?? []);
    // 随手评点（aside）只读白名单：restrictToolsTo 存在时本回合只暴露"白名单 ∩ 已注册"。
    // 正向枚举——漏列的后果是"少个工具"，不是"多个洞"；undefined = 不收口、行为不变。
    const allowSet = input.restrictToolsTo ? new Set(input.restrictToolsTo) : null;
    const toolDefs = Array.from(this.tools.values())
      .filter((t) => !denylist.has(t.name) && (!allowSet || allowSet.has(t.name)))
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
      }));
    // 执行分发面与声明面同源：模型幻觉出「未声明但已注册」的工具名时不得直通 this.tools
    // 执行——白名单/denylist 回合下这是收口的执行面（声明面过滤只挡「看见」，挡不住「点名」）。
    const declaredToolNames = new Set(toolDefs.map((t) => t.name));

    // v0.2 prompt cache：systemContext 拆稳定 + 动态两段，给稳定段标 ephemeral cache_control
    // 命中后 Anthropic 端直接复用，省 token + 加速。动态段每次重算（dream / promptHints 变化）
    // 仅当当前 RegisteredModel.supportsPromptCache=true 时启用 cache_control，否则降级为纯字符串
    const systemField = buildSystemField(
      input.systemContext,
      input.stableSystemContext,
      input.sessionStableSystemContext,
      this.supportsPromptCache,
    );
    const maxTokens = this.maxOutputTokens ?? DEFAULT_MAX_TOKENS;

    // 工具 round-trip：循环 / 工具并发 / steering 边界 / usage 累加抽到共享内核 runRoundTrip（D1）；
    // 本 backend 只提供 AnthropicRoundTripAdapter——wire 解析 / wire 落位 / usage 口径 / 事件形状全在它里。
    const adapter = new AnthropicRoundTripAdapter({
      client,
      model,
      systemField,
      maxTokens,
      toolDefs,
      messages,
      buildSeed: async (h) => (await buildSeed(h)).coalesced,
      computeUsage: (i, o, cr, cc, m, s) => this.buildUsage(i, o, cr, cc, m, s),
    });
    yield* runRoundTrip(
      adapter,
      input,
      (name, toolInput) => this.executeToolSafe(name, toolInput, ctx),
      declaredToolNames,
    );
  }

  async runOneShot(input: OneShotInput, signal?: AbortSignal): Promise<OneShotResult> {
    const client = new Anthropic({
      ...this.clientAuth(),
      baseURL: this.baseURL,
    });
    const model = input.model ?? this.defaultModel;

    // outputSchema：Anthropic 没有原生 json_schema 模式，靠 prompt 注入要求 LLM 输出 JSON
    const append = input.outputSchema
      ? `${input.systemContext ?? ''}\n\n你必须以一段合法 JSON 返回，符合下面这个 schema（不要加 markdown 围栏，不要解释，只输出 JSON）：\n${JSON.stringify(input.outputSchema, null, 2)}`
      : input.systemContext;

    // 带图（aside 窗口截图等）→ user content 升级为 vision blocks（图在前、文在后，
    // 与主对话路径 toAnthropicMessageParam 一致）；无图保持纯字符串，请求形状零变化
    const content: string | AnthContentBlockParam[] =
      input.images && input.images.length > 0
        ? [
            ...input.images.map(
              (img): AnthContentBlockParam => ({
                type: 'image',
                source: {
                  type: 'base64',
                  // OneShotInput.images 的 mediaType 在 shared 层是 string（调用方保证是合法图片类型），
                  // 此处收窄到 SDK 的字面量联合
                  media_type: img.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                  data: img.base64,
                },
              }),
            ),
            { type: 'text', text: input.prompt },
          ]
        : input.prompt;

    // 防搜索摘要循环：runOneShot **永不**带 tools——任何时候 messages.create 不传 tools 字段。
    // 这是 web_fetch 长摘要 summarizer 的安全前提：summarizer 调 runOneShot 时模型看不到任何工具，
    // 不可能再次触发 web_fetch。详见 docs/tech/2026-05-07-web-search-tech-design.md §8.2。
    const resp = await client.messages.create(
      {
        model,
        max_tokens: this.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        // cacheSystem：把整段 system 标记 ephemeral（召回挑选器等「systemContext 短时复用」场景，
        // 让稳定前缀命中 cache、每轮只重算对话尾部）。否则纯字符串、不缓存。
        system: append?.trim()
          ? input.cacheSystem
            ? [{ type: 'text', text: append, cache_control: { type: 'ephemeral' } }]
            : append
          : undefined,
        messages: [{ role: 'user', content }],
      },
      { signal },
    );

    const text = resp.content
      .filter((b): b is Extract<_AnthBlockHint, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const u = resp.usage;
    const usage = this.buildUsage(
      u?.input_tokens ?? 0,
      u?.output_tokens ?? 0,
      u?.cache_read_input_tokens ?? 0,
      u?.cache_creation_input_tokens ?? 0,
      resp.model,
      Boolean(u),
    );
    return { text: text.trim(), usage };
  }

  /** debug：从累加的原始字段拼成 ConversationUsage（仅在最终 yield result 时用一次） */
  private buildUsage(
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    actualModel: string | undefined,
    sawUsage: boolean,
  ): ConversationUsage | undefined {
    if (inputTokens === 0 && outputTokens === 0 && !actualModel) return undefined;
    const extended: Record<string, unknown> = {};
    // 见过 usage 才输出 cacheReadTokens（即使 0）——UI 区分 "真未命中" 与 "未返回 usage"
    if (sawUsage) extended.cacheReadTokens = cacheReadTokens;
    if (cacheCreationTokens > 0) extended.cacheWriteTokens = cacheCreationTokens;
    return {
      inputTokens: inputTokens || undefined,
      outputTokens: outputTokens || undefined,
      actualModel,
      extended: Object.keys(extended).length > 0 ? extended : undefined,
    };
  }

  /** 执行单个工具，把异常吃掉转成 isError=true 文本——保证 round-trip 不漏回执 */
  private async executeToolSafe(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext | undefined,
  ): Promise<ToolExecResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { text: `未知工具：${name}`, isError: true };
    }
    if (!ctx) {
      return { text: `工具 ${name} 缺少 ToolContext 上下文，无法执行`, isError: true };
    }
    try {
      const result: AgentToolResult = await executeAgentTool(tool, input, ctx);
      // 视觉降级与附件路径同一口径（见 attachmentLoaderFor 的 targetSupportsVision）：本 backend
      // 不只服务 Anthropic 直连——glm-coding / kimi-coding / minimax-coding 三家 coding plan 也走
      // anthropic-native 协议（providerProtocol.ts），它们的搭载款 supportsVision 全是 false。
      // 无条件发 image block 会让那三家的端点每一轮都失败。文字告知而非静默丢，模型才不会
      // 对着看不见的图编描述。
      if (result.images?.length && !this.supportsVision) {
        return {
          text: `${result.text}\n[这个工具回传了图片，但当前模型不支持看图，无法据图判断]`,
          isError: result.isError ?? false,
          structured: result.structured,
        };
      }
      return {
        text: result.text,
        isError: result.isError ?? false,
        structured: result.structured,
        images: result.images,
      };
    } catch (e) {
      return {
        text: `工具 ${name} 抛错：${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  }
}

// ─── 把 NormalizedMessage 翻译为 Anthropic API 接受的 MessageParam ────

async function toAnthropicMessageParam(m: NormalizedMessage): Promise<AnthMessageParam> {
  if (m.role === 'user') {
    const content = await Promise.all(
      m.blocks.map(async (b): Promise<AnthContentBlockParam> => {
        if (b.type === 'text') {
          return { type: 'text', text: b.text };
        }
        if (b.type === 'image') {
          // 容错：load() 失败时（例如 conv.clear 与 runChat race 导致 ENOENT，
          // 或老消息引用的图片被外部删除）转成占位文字，避免整个请求崩溃
          // invariant: adapter 输出的 image block 必含 load（attachmentLoaderFor 注入）；
          // load 在类型上设可选是给落盘/跨进程场景（v0.5 wireHistory），运行时一定有
          try {
            const data = await b.load!();
            return {
              type: 'image',
              source: { type: 'base64', media_type: b.mediaType, data },
            };
          } catch {
            return { type: 'text', text: `[图片加载失败：${b.filename}]` };
          }
        }
        // tool_result block
        return {
          type: 'tool_result',
          tool_use_id: b.toolUseId,
          content: b.content,
          is_error: b.isError,
        };
      }),
    );
    return { role: 'user', content };
  }
  // assistant
  const content = m.blocks.map((b): AnthContentBlockParam => assistantBlockToParam(b));
  return { role: 'assistant', content };
}

function assistantBlockToParam(b: AssistantBlock): AnthContentBlockParam {
  if (b.type === 'text') {
    return { type: 'text', text: b.text };
  }
  return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
}

type AnthSystemPart = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

function buildSystemField(
  full: string | undefined,
  stable: string | undefined,
  sessionStable: string | undefined,
  enableCache: boolean,
): string | undefined | AnthSystemPart[] {
  if (!full?.trim()) return undefined;
  if (!enableCache) return full;
  // 两层缓存——传 sessionStable 时 stable + 会话级稳定段各打一个 breakpoint。
  const segs = cachedSystemSegments(full, stable, sessionStable);
  if (segs.length === 1 && !segs[0].cached) return full;
  return segs.map((seg) =>
    seg.cached
      ? { type: 'text', text: seg.text, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text: seg.text },
  );
}

/**
 * Anthropic 协议适配器（D1）——把 Anthropic 的 wire 解析 / wire 落位 / usage 口径 / per-call 事件形状
 * 喂给共享内核 runRoundTrip。控制流（循环 / 工具并发 / steering 边界）全在内核。
 */
class AnthropicRoundTripAdapter implements ProtocolAdapter {
  private usageInputTokens = 0;
  private usageOutputTokens = 0;
  private usageCacheReadTokens = 0;
  private usageCacheCreationTokens = 0;
  private usageActualModel: string | undefined;
  private sawUsage = false;

  /** seed 段边界：this.d.messages 前 seedLen 条是 seed，其后是本回合 in-flight（assistant/tool_result）。 */
  private seedLen: number;

  constructor(
    private readonly d: {
      client: Anthropic;
      model: string;
      systemField: ReturnType<typeof buildSystemField>;
      maxTokens: number;
      toolDefs: Array<{ name: string; description: string; input_schema: Anthropic.Messages.Tool.InputSchema }>;
      messages: AnthMessageParam[];
      /** 用整理后的 history 重译 seed 段（复用 runConversation 的 buildSeed，coalesce 后返回）。 */
      buildSeed: (history: ChatMessage[]) => Promise<AnthMessageParam[]>;
      computeUsage: (
        i: number,
        o: number,
        cr: number,
        cc: number,
        m: string | undefined,
        s: boolean,
      ) => ConversationUsage | undefined;
    },
  ) {
    this.seedLen = d.messages.length;
  }

  /**
   * S16 G66 续发检查点：用整理后的 history 重建 seed 段，本回合 in-flight 逐字节保留其后。
   * 拼接边界重跑 coalesce 防相邻同角色 400——常态下 seed 末条是本轮 user、in-flight 首条是
   * assistant（不同 role、不合并），coalesce 为防御；组织后视图恒以 user 结尾故边界不会合并。
   */
  async replaceSeedHistory(history: ChatMessage[]): Promise<void> {
    const inflight = this.d.messages.slice(this.seedLen);
    const newSeed = await this.d.buildSeed(history);
    this.d.messages = coalesceAdjacentSameRole([...newSeed, ...inflight]);
    // 边界未合并（常态）→ seedLen=newSeed.length；即便合并，seed 段 = 总长 − in-flight 长（wire 正确）。
    this.seedLen = this.d.messages.length - inflight.length;
  }

  async *streamOnce(signal: AbortSignal): AsyncGenerator<ConversationEvent, RoundResult> {
    // 累积本轮的 assistant content blocks（要回传给 messages 数组用 ContentBlockParam 形态，不带 caller）
    const assistantContent: AnthContentBlockParam[] = [];
    // 累积每个 block 的临时状态
    const builders: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; jsonBuf: string }> = [];
    let stopReason: string | null = null;

    // 本次 stream（即本次 LLM 调用）的 usage——结束时 yield llm_usage 给 debug
    let perCallInputTokens = 0;
    let perCallOutputTokens = 0;
    let perCallCacheReadTokens = 0;
    let perCallSawUsage = false;

    // S25 G09：首事件前可重试——网络/限流/5xx 在还没吐出任何内容时自动重发并 yield retrying
    //（用户看到「正在重试」）。常见瞬时故障（断网/连不上/429/5xx）都在连接建立、message_start
    // 到达之前就抛出 → 零 raw 事件 → 重试，正是 M2「还没回话·原样重发」要覆盖的形态。
    // 边界刻意保守：**只在零 raw 事件时重试**（produced 由 retryStreamStart 收到首个 raw 事件即置），
    // 故上面的累加器（含 this.usage* 在 message_start 里加的输入 token）在重试点必为空、绝不双计；
    // 代价是「已连上、message_start 到了但正文前就断」这一窄窗不自动重发（落红条 + 手动 [重试]），
    // 罕见且优雅兜底，换来免去「重试时回滚累加器」的复杂度。一旦流出正文再断即交 runner 续写（M3）。
    // 每次尝试新开一条流。
    const openStream = (s: AbortSignal) =>
      this.d.client.messages.stream(
        {
          model: this.d.model,
          max_tokens: this.d.maxTokens,
          system: this.d.systemField,
          messages: this.d.messages,
          tools: this.d.toolDefs.length > 0 ? this.d.toolDefs : undefined,
        },
        { signal: s },
      ) as AsyncIterable<RawMessageStreamEvent>;

    for await (const item of retryStreamStart(openStream, isRetryableAnthropicError, DEFAULT_RETRY, signal)) {
      if (item.kind === 'retrying') {
        yield { type: 'retrying', attempt: item.attempt, maxRetries: item.maxRetries };
        continue;
      }
      const ev = item.event;
      switch (ev.type) {
        case 'content_block_start': {
          const blk = ev.content_block;
          if (blk.type === 'text') {
            builders.push({ type: 'text', text: '' });
          } else if (blk.type === 'tool_use') {
            builders.push({ type: 'tool_use', id: blk.id, name: blk.name, jsonBuf: '' });
          } else {
            // 其他类型（thinking / server_tool_use 等）暂不处理；占位避免 builders 索引错位
            builders.push({ type: 'text', text: '' });
          }
          break;
        }
        case 'content_block_delta': {
          const last = builders[builders.length - 1];
          if (!last) break;
          if (ev.delta.type === 'text_delta' && last.type === 'text') {
            last.text += ev.delta.text;
            yield { type: 'assistant_text', text: ev.delta.text };
          } else if (ev.delta.type === 'input_json_delta' && last.type === 'tool_use') {
            last.jsonBuf += ev.delta.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          const last = builders[builders.length - 1];
          if (!last) break;
          if (last.type === 'text') {
            // 空 text block 不落进 assistantContent：模型开了文本块但一个 delta 都没吐
            // （守则让模型调工具时别说话，Kimi 就会先开块再空关），原样进下一轮请求会被
            // 严格的 anthropic 兼容端点 400「text content is empty」——丢掉语义不变
            if (last.text.length > 0) assistantContent.push({ type: 'text', text: last.text });
          } else if (last.type === 'tool_use') {
            let parsedInput: Record<string, unknown> = {};
            if (last.jsonBuf.length > 0) {
              try {
                parsedInput = JSON.parse(last.jsonBuf) as Record<string, unknown>;
              } catch {
                // 解析失败 → 空对象（工具会自己报错）
              }
            }
            assistantContent.push({
              type: 'tool_use',
              id: last.id,
              name: last.name,
              input: parsedInput,
            });
            yield { type: 'tool_use', id: last.id, name: last.name, input: parsedInput };
          }
          break;
        }
        case 'message_delta': {
          if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
          // debug：output_tokens 在 message_delta 里
          if (ev.usage?.output_tokens) {
            this.usageOutputTokens += ev.usage.output_tokens;
            perCallOutputTokens += ev.usage.output_tokens;
          }
          break;
        }
        case 'message_start': {
          // debug：input_tokens / cache_* 在 message_start 里；model 也在这里
          const u = ev.message?.usage;
          if (u) {
            const inT = u.input_tokens ?? 0;
            const cachedT = u.cache_read_input_tokens ?? 0;
            const cacheCreateT = u.cache_creation_input_tokens ?? 0;
            // Anthropic API 把 input_tokens（非缓存）/ cache_read / cache_creation 分三块报。
            // ConversationUsage 维度仍按 API 原口径分开计（计费层），
            // 但 llm_usage 这条 debug 事件里 perCallInputTokens 走"总输入"口径——
            // 跟 OpenAI 兼容 backend 一致（那边 prompt_tokens 本来就含缓存），
            // 让前端能直接按 cacheReadTokens / inputTokens 算命中率。
            this.usageInputTokens += inT;
            this.usageCacheReadTokens += cachedT;
            this.usageCacheCreationTokens += cacheCreateT;
            perCallInputTokens += inT + cachedT + cacheCreateT;
            perCallCacheReadTokens += cachedT;
            this.sawUsage = true;
            perCallSawUsage = true;
          }
          if (ev.message?.model) this.usageActualModel = ev.message.model;
          break;
        }
        case 'message_stop':
        default:
          break;
      }
    }

    // 本次 LLM stream 结束 —— 把单次 usage emit 给 debug（derive 端绑到 llm_call_done.payload）
    yield {
      type: 'llm_usage',
      inputTokens: perCallInputTokens,
      outputTokens: perCallOutputTokens,
      cacheReadTokens: perCallSawUsage ? perCallCacheReadTokens : undefined,
    };

    // 把本轮 assistant message 加到 messages（用于下一轮 round-trip 上下文）
    if (assistantContent.length > 0) {
      this.d.messages.push({ role: 'assistant', content: assistantContent });
    }

    const toolUses = assistantContent.filter(
      (b): b is Extract<AnthContentBlockParam, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    // 无工具调用时的最终文本（result.resultText）
    const finalText = assistantContent
      .filter((b): b is Extract<AnthContentBlockParam, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      toolCalls: toolUses.map((tu) => ({ id: tu.id, name: tu.name, input: tu.input as Record<string, unknown> })),
      isToolCall: stopReason === 'tool_use',
      finalText,
    };
  }

  appendToolResults(
    results: Array<{ id: string; name: string } & ToolExecResult>,
    steeringTexts: string[],
    noticeTexts: string[],
  ): void {
    // 带图的工具结果拼成 [text, image...] 块数组喂回模型（Anthropic 的 tool_result 支持图像块）。
    // 这里只管形状：能不能看图已在 executeToolSafe 按 supportsVision 分流过，走到这里还带着
    // images 的就是该发图的模型。无图时保持纯字符串 content——形状与此前逐字节一致。
    const toolResultBlocks: AnthContentBlockParam[] = results.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.id,
      content: r.images?.length
        ? [
            { type: 'text' as const, text: r.text },
            ...r.images.map((img) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
            })),
          ]
        : // 空串 tool_result content 同样被严格端点 400——工具没话说时给个占位
          r.text.length > 0 ? r.text : '（工具没有返回内容）',
      is_error: r.isError,
    }));
    // Steering：动作边界 drain——取走这一刻被读入的「将生效」文本，搭进本轮 tool_result 的 user turn
    // （tool_result 本是 user 角色，搭车天然规避"连续 user 被 Anthropic 拒"）。模型在下一次调用即时转向。
    const userTurnContent: AnthContentBlockParam[] = [...toolResultBlocks];
    if (steeringTexts.length > 0) {
      userTurnContent.push({ type: 'text', text: `${STEERING_SUPPLEMENT_PREFIX}\n${steeringTexts.join('\n\n')}` });
    }
    // 边界系统通知（后台终态）：纯文本块，不套用户补话前缀（它是系统记，不是用户说的）
    for (const n of noticeTexts) {
      userTurnContent.push({ type: 'text', text: n });
    }
    this.d.messages.push({ role: 'user', content: userTurnContent });
  }

  buildResultUsage(): ConversationUsage | undefined {
    return this.d.computeUsage(
      this.usageInputTokens,
      this.usageOutputTokens,
      this.usageCacheReadTokens,
      this.usageCacheCreationTokens,
      this.usageActualModel,
      this.sawUsage,
    );
  }
}
