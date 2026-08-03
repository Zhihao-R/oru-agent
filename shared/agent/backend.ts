/**
 * AgentBackend 抽象层 — 所有 LLM provider 集成的统一接口
 *
 * 这一层比 `electron/main/engine` 更高级。`engine` 抽象的是"执行 Claude Agent SDK
 * 风格的 query"；`AgentBackend` 抽象的是"驱动一个 agent 跟用户对话"。
 *
 * 当前 v0.1 的实现：
 * - `ClaudeCodeBackend`：内部用 `engine.run()`（→ Claude Agent SDK）
 *
 * 未来可加：
 * - `AnthropicApiBackend`：直接用 `@anthropic-ai/sdk`，不经过 engine
 * - `OpenAiBackend`：用 OpenAI SDK
 *
 * 设计原则：
 * - 类型名和字段名用中性术语，禁止泄漏 provider-specific 概念（不能出现 "MCP"、
 *   "systemPrompt.append"、"messages.create" 这种字眼）
 * - 业务 callback（如 `onProposal`）属于 Oru 业务事件，不是 LLM 细节，可以在接口里
 * - 接口只暴露当前用到的能力，不为 hypothetical 扩展过度抽象
 */
import type { NormalizedMessage } from '@shared/agent/normalizedMessage';
import type { ProposalOutcome } from '@shared/proposals/outcome';
import type {
  ActionProposal,
  ApprovalMode,
  AskUserChoiceQuestion,
  BackendType,
  ChatMessage,
  ChecklistItem,
  LlmUsage,
  MemoryRecordPayload,
  TodoItem,
  ToolProtocol,
} from '@shared/types';

// ─── Nominal types ──────────────────────────────────────────

/**
 * **稳定 system 前缀的 nominal brand**——只能由 `buildStableSystemContext` 出口构造。
 *
 * 用途：对话期 subagent 派遣时必须复用主对话的稳定段（不含动态时间 / conversationId 等）
 * 才能命中 cache。直接 fork 完整 systemContext 会把 dynamic 段也带进去，
 * 导致 cache miss + subagent 看到上一轮的旧时间。
 *
 * Nominal type 在编译期拦截"裸 string 当 stable system 用"的事故——
 * RunSubagentDeps.parentStableSystemContext 字段要求此类型，其他地方拿到的 string
 * 无法直接传入。
 */
export type StableSystemContext = string & { readonly __brand: 'StableSystemContext' };

/**
 * Steering 中途补充注入前缀——三后端把动作边界读入的「将生效」文本拼进下一次模型调用时统一冠它，
 * 让模型识别这是「用户在你干活时补的话」。系统记（drainBoundaryNotice 的后台终态）**不**用它。
 * 单一常量收口，避免三处字面量漂移。
 */
export const STEERING_SUPPLEMENT_PREFIX = '【用户中途补充】';

// ─── 主要接口 ──────────────────────────────────────────────

export interface AgentBackend {
  /** Backend 类型标识；落盘 ChatMessage 时写入 meta，用于跨 backend 切换识别 */
  readonly backendType: BackendType;
  /** 工具调用协议形态；落盘时写入 meta，跨协议切换时 historyAdapter 据此折叠 */
  readonly toolProtocol: ToolProtocol;
  /**
   * 当前实例使用的 RegisteredModel.id（factory 实例化时塞进去）。
   * 落盘 ChatMessage 时写入 meta；OAuth fallback / 走 SDK 默认时为 undefined。
   */
  readonly modelId?: string;
  /**
   * 当前实例使用的 BackendProvider.id（factory 实例化时塞进去）。
   * 落盘 ChatMessage 时写入 meta；OAuth fallback 时为 undefined。
   */
  readonly providerId?: string;

  /** 启动一段对话流；返回一个事件迭代器，调用方 for-await 消费 */
  runConversation(input: ConversationInput): ConversationHandle;

  /**
   * 一次性 LLM 调用（用于 dream 复盘等离线任务）。带 outputSchema 时要求结构化输出。
   * 返回文本 + 本次 token 用量（usage 拿不到时为 undefined，同 runConversation 的 result.usage 口径）——
   * 调试日志据此给后台 oneShot 调用展示 token，与主对话可观测性对齐。
   */
  runOneShot(input: OneShotInput, signal?: AbortSignal): Promise<OneShotResult>;

  /** 注册一个工具，下次 runConversation 时会暴露给 LLM */
  registerTool(tool: AgentTool): void;

  /** 注销已注册的工具 */
  unregisterTool(name: string): void;

  /**
   * 当前 backend 是否具备对外服务的最小条件（鉴权 / 配置齐了）。
   * 用于 runner 入口校验，避免起 streaming 后才发现 key 错。
   * - ClaudeCodeBackend：调 detectAuth 判断 OAuth/env/manualApiKey 至少一种 ready
   * - AnthropicBackend / OpenAICompatibleBackend：检查 settings 里对应 provider 的 apiKey 非空
   */
  isReady(): Promise<{ ok: boolean; hint: string }>;
}

// ─── runConversation ────────────────────────────────────────

export type ConversationInput = {
  /** 当前 agent id；backend 内部需要它来定位 conversation 下的图片附件目录等资源 */
  agentId: string;
  /** 当前对话 id（业务层用来对账） */
  conversationId: string;
  /**
   * 用户输入文本（也是 history 的最后一条 user 消息；保留作便利字段）。
   * 续跑（审批通过后自动接着干）时为 undefined——无新用户消息，从 history 末尾的「系统记」user 轮继续。
   */
  userMessage?: string;
  /**
   * 本对话已落盘的全部 ChatMessage（含本轮新加的 user 消息）。
   * - ClaudeCodeBackend：无 sdkSessionId 时灌历史（renderSeedPrompt）成首条 prompt；有 sdkSessionId 走 SDK 原生 resume
   * - AnthropicBackend / OpenAICompatibleBackend：整段 replay 历史
   */
  history?: ChatMessage[];
  /**
   * 本次跑哪个 model id；不传则用 backend 默认。
   * - ClaudeCodeBackend：透到 SDK Options.model（如 'claude-sonnet-4-6'）
   * - AnthropicBackend / OpenAICompatibleBackend：直接喂 API
   */
  model?: string;
  /** 注入到 system prompt 的上下文（agent 人设、记忆快照等。backend 决定怎么塞给 LLM） */
  systemContext?: string;
  /**
   * v0.2：systemContext 的"稳定前缀"部分（人设、记忆系统使用规则、运行环境约定等不常变内容）。
   * 缺省/与 systemContext 相同时整段视为动态——不利用 cache。
   * 支持 cache 的 backend（Anthropic）会把这一段标记为 ephemeral cache_control，让稳定前缀真正命中 cache。
   * 必须满足：systemContext.startsWith(stableSystemContext)——后续部分（动态）放在它后面。
   */
  stableSystemContext?: string;
  /**
   * 比 stableSystemContext 更长的"会话级稳定前缀"。主对话传 stable + 能力 prompt +
   * 记忆快照（低频变化：记忆落盘后下一轮才变）；对话期 subagent 传整段 fullSystem
   * （= parentStable + 角色后缀 + 能力 prompt，无动态尾部）。子 agent fork 的
   * stableSystemContext 仍是纯 parentStable，靠它命中主对话的第一断点缓存。
   * 支持显式 cache 的 backend 会在 stableSystemContext 与本段末尾各打一个 cache breakpoint：
   * 前者供子 agent 复用、后者让主对话缓存快照。
   * 必须满足：systemContext.startsWith(sessionStableSystemContext) 且
   * sessionStableSystemContext.startsWith(stableSystemContext)；不满足则优雅退回单层。
   * backend 实现不要单独解读这两个字段，统一喂给 `cachedSystemSegments(full, stable, sessionStable)`
   * 拿到"缓存段序列"再映射成各自 wire 形态——前缀关系与退化都在那里处理。
   */
  sessionStableSystemContext?: string;
  /** 续传 session id（由上次 'session' 事件给出） */
  resumeSessionId?: string;
  /** 工作目录（影响 LLM 看到的本地文件） */
  cwd: string;
  /** 调用方的 abort controller（取消时 backend 应中止 LLM 调用） */
  abortController: AbortController;
  /**
   * 显式允许的工具白名单（不传则跟随 backend 默认）。
   * - ClaudeCodeBackend：透传给 SDK Options.allowedTools（含内置工具如 Read/Write/Edit/Bash 等）
   * - 其他 backend：通常忽略（它们的工具集就是 registerTool 注入的，没有内置工具）
   */
  allowedTools?: string[];
  /**
   * 显式禁用的工具黑名单。
   * - ClaudeCodeBackend：透传给 SDK Options.disallowedTools
   * - AnthropicApiBackend / OpenAICompatibleBackend：从注册的工具集中过滤掉同名工具
   *   （PR-D2 起接入；评论场景用来 deny Task / commit_changes）
   */
  disallowedTools?: string[];
  /**
   * 本回合的工具白名单（aside 只读短聊等收口场景）。白名单存在时，后端必须保证模型
   * 只看得到白名单内的工具——已注册工具按名过滤，provider 自带的内置工具一并关闭。
   * 与上面两个字段的分工：allowedTools / disallowedTools 是对 backend 默认工具集的增减透传；
   * 本字段是跨 backend 的硬收口（正向枚举——漏列的后果是"少个工具"，不是"多个洞"）。
   * undefined = 不收口、行为不变；空数组 = 一个工具都不暴露（fail-closed，安全字段取保守向）。
   */
  restrictToolsTo?: readonly string[];
  /**
   * 三态推理（thinking）开关，各后端用自己的手段：
   * - OpenAICompatible（OR 路径）：true → 请求体 reasoning: { enabled: false }；false → reasoning 开；undefined 不压
   * - ClaudeCode：**默认就压**（maxThinkingTokens: 0 治"慢"，实测默认 undefined 会非确定触发 thinking 吃延迟）。
   *   只有显式 `false`（思考开关打开）才放开思考 → undefined。即 undefined/true → 0，false → 放开。
   * - Anthropic 直连：false → 请求体加 thinking:{type:'enabled',budget_tokens}；true/undefined 不发（关/缺省）。
   * 取值来源（Track B runner.ts）：按本回合 usage 走 resolveThinkingDisable 定三态。
   */
  disableReasoning?: boolean;
  /**
   * 逐 token 流式：true 时后端开启 SDK/transport 的增量输出，消费方逐段收到 assistant_text。
   * **per-run 决策**——只有"用户在实时看输出"的路径（主对话 / subagent chat）传 true；
   * 只取终值的路径（dream / 背景 query / loop 编译）不传，避免白付增量成本（claude-code 下增量要穿子进程边界）。
   * 仅 ClaudeCode 后端区分此开关（HTTP 后端本就逐 delta、无额外成本）；不传 = 不开。
   */
  streaming?: boolean;
  /** 已注册的 AgentTool 在执行时会拿到的上下文（agentId / ownerId 等）。不传则注册的工具不暴露给本次对话 */
  toolContext?: ToolContext;

  // ─── 通用 hook ──────────────────────────────────────────
  /** 用户消息提交后、LLM 看到前的钩子（可返回额外 context） */
  onUserPromptSubmit?: () => Promise<{ additionalContext?: string } | void>;
  /** 会话启动时的钩子 */
  onSessionStart?: () => Promise<{ additionalContext?: string } | void>;
  /**
   * Steering（对话忙时中途转向）：后端在每个**动作边界**（tool_result → 下一次模型调用之间）调它，
   * 取走那一刻被读入的「将生效」文本（已由 runner 侧 pullSteering 落盘+广播 consumed，单源），
   * 拼进下一次模型调用即时转向。
   * - AnthropicBackend / OpenAICompatibleBackend：进程内 while 循环天然支持，把文本搭进 tool_result 的 user turn。
   * - ClaudeCodeBackend：SDK 自驱循环碰不到内部边界，在工具边界先 hasPendingSteering 探测、再 interrupt
   *   截断当前轮，截断后才调本回调落盘+续喂（落盘=消费，先于 appendInput 投递）。
   * 不挂 = 无 steering（行为零变化）；返回空数组 = 这一刻没有待读入的。
   */
  drainSteering?: () => Promise<string[]>;
  /**
   * Steering 待读入探测（**非消费**）：claude-code 专用——SDK 自驱 query 内拿不到工具边界，需先探测
   * 「此刻队列有无待读入的将生效」来决定是否 interrupt 截断当前轮（interrupt 会 abort 在途工具，不能空放）。
   * 返回 true 才在下一个 tool_result 边界 interrupt；截断产出 result 后再 drainSteering 落盘+续喂。
   * anthropic/openai 不用（while 循环里直接 drainSteering 搭车，无需先探测）。
   * **本回调的存在与否即 claude-code「是否走 steering 活流」的开关**——挂 = 持续活流 + interrupt 驱动；
   * 不挂 = 单发 string prompt、行为零变化（subagent / oneShot / aside 均不挂）。
   * **契约：与 drainSteering 必须成对挂载**——steerable 路径先 hasPendingSteering 探测、interrupt 后 drainSteering
   * 落盘续喂，单挂其一行为未定义（router 主对话起回合处一并绑定，见 ws/router.ts chat.send）。
   */
  hasPendingSteering?: () => boolean;
  /**
   * 边界系统通知 drain：动作边界把「已完成但未播报的后台任务」终态带出注入（**不套「【用户中途补充】」
   * 前缀**——它是系统记，不是用户补话）。返回非空则注入为纯文本块；内部已 markAnnounced 去重，与
   * taskAnnouncer 主动播报、回合起点 systemContext 注入同去重位（announcedAt），不双注入/双播。
   * 不挂 = 不在边界注入（仍由回合起点 systemContext + 空闲主动播报负责）。
   *
   * **注入时机按后端不同（刻意，非裂缝）**：
   * - anthropic/openai（进程内 while）：**每个 tool_result 边界**都调，与有无 steering 无关——后台终态
   *   一完成就在下一个边界顺势带出。
   * - claude-code（SDK 自驱）：**只在 steering 触发 interrupt 的边界**随 steering 一并带出。纯为后台
   *   通知去 interrupt 截断一个在途工具不划算（违背「最小化 interrupt」），故无 steering 时后台终态
   *   退回「回合起点 + 空闲主动播报」——比 anthropic/openai 略晚，是 claude-code 既有近似性的延伸。
   */
  drainBoundaryNotice?: () => Promise<string[]>;
  /**
   * 每次续发请求前的检查点（S16 G66）：本轮工具回执已就位、下一次模型请求发出之前调用。
   * 只挂 HTTP 两后端（anthropic / openaiCompatible）；claude-code 的工具循环在 SDK 内部、
   * 由其内建自动压缩兜住回合中途，不挂此钩子（实施方案 §3.3）。
   *
   * 返回 null＝不整理、照发；返回 history＝调用方已完成整理，backend 用它替换 seed 段
   * （replaceSeedHistory），本回合内已产生的轮次逐字节保留。
   * reason='overflow' 时上一次续发请求已被模型服务以超窗拒绝，调用方应强制整理；仍返回 null
   * 则 backend 把原错误原样抛出。
   *
   * 本钩子只覆盖「续发请求发出前」这一个时机（本轮尚未 yield 任何事件）；断线续写（流已开后
   * 中断）是不同时机、归 S25，不复用本钩子。签名刻意不带 token 数字——估算所需输入全在 runner，
   * backend 只报告「到检查点了」。不挂 = 行为零变化（subagent / oneShot / aside 均不挂）。
   */
  onBeforeContinuation?: (info: {
    /** 本回合第几次续发，首次续发为 1（首个请求不经此钩子，归回合入口检查管） */
    continuationIndex: number;
    reason: 'checkpoint' | 'overflow';
  }) => Promise<ChatMessage[] | null>;
  /**
   * 推理视图 telemetry + adapter 输出归档回调；backend 在调用 historyAdapter 后调一次。
   * runner 注入此回调把数据落到 debugLogger，让"算 savings 的层"和"写日志的层"解耦。
   *
   * v0.5：新增 wireHistory（adapter 之后的真实入参）+ adapterRan（adapter 是否真跑过）。
   * claudeCode resume 路径不跑 adapter，传 `adapterRan: false, wireHistory: []`；
   * 其他路径传 `adapterRan: true, wireHistory: normalized`。
   *
   * adapterRan 作为独立布尔字段——避免"wireHistory 为空数组"被误用作 resume 信号
   * （正常 adapter 在边界输入下也可能返回 []，跟 resume 撞车）。
   */
  onInferenceView?: (info: {
    enabled: boolean;
    adapterRan: boolean;
    savings: InferenceViewSavings;
    wireHistory: NormalizedMessage[];
  }) => void;
};

/**
 * 推理视图裁剪节省统计——由 historyAdapter 在裁剪过程中顺手统计，backend 透传给 debugLogger。
 * 字符 → token 的换算放在离线分析阶段（避免 token 估算误差锁死在日志里）。
 *
 * v0.4：所有"次数 + 字符"成对——便于离线分析单条平均节省。
 */
export interface InferenceViewSavings {
  /** 裁 2：被白名单丢弃的 system 消息条数 */
  systemMessagesFiltered: number;
  /** v0.4：detail 被 persistedRef.preview 替代的 toolResult 条数（源头落盘） */
  persistedReplaced: number;
  /** v0.4：persistedRef.preview vs detail 减少的字符数 */
  persistedCharsReduced: number;
  /** v0.4：写入型回执（record_memory）被白名单去重的条数 */
  writeAckDeduped: number;
  /** v0.4：写入型回执去重减少的字符数 */
  writeAckCharsReduced: number;
  /** v2：subagent chip（kind='subagent' 的 assistant 摘要消息）被过滤的条数——不喂回主 agent LLM */
  subagentChipsFiltered: number;
}

export type ConversationHandle = {
  /** 事件流；调用方 for-await 消费 */
  events: AsyncIterable<ConversationEvent>;
};

/**
 * 流事件类型（中性，不绑定任何 SDK）。
 * 跟 EngineEvent 形状一致是巧合——AgentBackend 是更高级的抽象，
 * 未来可能加入 backend-specific 不存在的事件类型（比如 'thinking' 块）。
 */
export type ConversationEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      toolUseId: string;
      isError: boolean;
      content: unknown;
      /** 工具上抛的结构化元数据，落盘到 ToolResult.structured */
      structured?: Record<string, unknown>;
    }
  /** transport 层 retry 通知，stream.ts 透传成 ws chat.retrying。
   *  当前仅 OpenAIBackend 在 5xx/网络错时发；其他 backend 走自家 SDK retry，不发此事件。 */
  | { type: 'retrying'; attempt: number; maxRetries: number }
  /**
   * 单次 LLM 调用结束时发——含本次调用的 input / output token。
   * debug 模块用来给"LLM 调用 #N"展示单次 token；主对话路径忽略。
   *
   * 一轮里若发生多次 LLM 调用（带工具调用），每次调用结束都会发一次 llm_usage；
   * 调用顺序跟 derive 的 callIndex 一致——derive 把当前累积窗口收尾时把这条数据填进 llm_call_done.payload.
   *
   * 拿不到的 backend（如 ClaudeCodeBackend，SDK 不暴露）不发——derive 端把字段留空即可。
   */
  | {
      type: 'llm_usage';
      inputTokens?: number;
      outputTokens?: number;
      /**
       * 本次 LLM 调用 prompt cache 命中 token 数。
       * undefined → backend 没拿到 usage（智谱平台偶发漏 / provider 不支持 include_usage）。
       * 0 → 拿到 usage 但本次确实未命中。
       * > 0 → 命中。
       */
      cacheReadTokens?: number;
      /**
       * Provider-specific 单次 usage 扩展容器，与 ConversationUsage.extended 同型。
       * key 命名约定见 shared/debug/types.ts 的 NORMALIZED_USAGE_KEYS
       * （reasoningTokens / cacheWriteTokens 等）。
       */
      extended?: Record<string, unknown>;
      /**
       * 本次调用终止原因（透传 OpenAI 兼容协议 choice.finish_reason）。
       * 'stop' / 'length' / 'tool_calls' / 'content_filter' / 其它；
       * 'length' 表示触达 max_tokens 被截断——输出被截断的典型信号。
       * undefined → 非 OpenAI 兼容协议或上游 stream 提前断开。
       */
      finishReason?: string;
    }
  | {
      type: 'result';
      resultText: string | null;
      isError: boolean;
      /**
       * 本回合是否流过 reasoning（思考通道）delta——推理模型可能「只思考不产正文」
       * （HTTP 200、resultText 空，hy3 前科）。地基层只解析不展示；空产出报错文案据此
       * 区分「模型思考了但没给出回答」与「压根没响应」。当前仅 openaiCompatible 填。
       */
      sawReasoning?: boolean;
      /**
       * 本轮 LLM 调用的 token 用量（debug 模块消费；主对话路径不读）。
       * 各 backend 自行填——能拿到就填，拿不到就 undefined（不为了凑齐字段而硬编）。
       *
       * 设计原则：shared 层只暴露通用字段（inputTokens / outputTokens / actualModel）；
       * provider-specific 概念（cacheReadTokens / cacheWriteTokens / reasoningTokens 等）
       * 塞进 extended 容器，避免泄漏 provider 细节进 backend.ts 抽象层。
       * 详见 docs/tech/2026-05-10-debug-module-tech-design.md §6.1。
       */
      usage?: ConversationUsage;
    };

export interface ConversationUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 实际生效的 model（fallback / SDK 默认时跟 input.model 不同） */
  actualModel?: string;
  /**
   * Provider 自由扩展容器。shared 层不固化任何 provider-specific 字段名。
   * 消费方（debug 模块）的推荐 key 命名约定见 `shared/debug/types.ts` 的 NORMALIZED_USAGE_KEYS——
   * 但本 backend 抽象层不引用 debug 模块，避免反向依赖。
   */
  extended?: Record<string, unknown>;
}

// ─── runOneShot ─────────────────────────────────────────────

export type OneShotInput = {
  /** 主提示 */
  prompt: string;
  /** 系统级上下文（可选） */
  systemContext?: string;
  /**
   * 把 systemContext 标记为可缓存（ephemeral）——用于「同一段 systemContext 在短时间内被多次复用」的
   * one-shot：召回挑选器每轮串联跑、systemContext=[指令+候选简介块] 一段对话内稳定，缓存它让每轮只重算
   * 对话尾部（PRD §5.4 简介缓存支柱）。支持显式缓存的 backend（Anthropic / OpenRouter 透传）据此打
   * cache_control；不支持的（ClaudeCode SDK 自管缓存）忽略。缺省 false——一次性、不复用的 one-shot
   * 不该付缓存写成本。
   */
  cacheSystem?: boolean;
  /** 工作目录（不传则用进程默认） */
  cwd?: string;
  /**
   * 期望的输出 JSON Schema（带了的话 backend 应尽量让 LLM 返回符合 schema 的 JSON）。
   * - OpenAICompatibleBackend 优先用 response_format: json_schema
   * - AnthropicBackend / ClaudeCodeBackend 退化为 prompt 注入 schema 文本
   */
  outputSchema?: object;
  /** 模型名（不传则用 backend 默认） */
  model?: string;
  /**
   * 随 prompt 入模的图片（aside 短评的窗口截图等）。base64 不带 data: 前缀。
   * 不传 = 纯文本调用，行为零变化；所配模型不支持视觉时调用方负责不传（backend 不做闸）。
   */
  images?: Array<{ base64: string; mediaType: string }>;
  /**
   * 显式关闭模型的推理（thinking）——各后端用自己的手段关思考（二期 §3 语义升级）：
   * - OR 路径：透传 `reasoning: { enabled: false }`，上游强制不思考
   * - ClaudeCode：engine 入参 maxThinkingTokens: 0（实测 SDK 0.1.77 能压住自适应思考；
   *   autoName 等既有调用方在此路顺带获得关思考——有意为之，命名本就不要思考）
   * - Anthropic 直连：false → 请求体加 thinking；true/undefined 不发
   *
   * 离线短调用（autoName / aside 短评）默认关——命名/短评用不上 reasoning，关掉省 10-20× 耗时；
   * 可按 usage 用户在设置里打开（Track B）。
   */
  disableReasoning?: boolean;
};

/** runOneShot 的返回——文本 + 可选 token 用量（usage 来源同 ConversationEvent.result.usage） */
export type OneShotResult = {
  text: string;
  usage?: ConversationUsage;
};

// ─── 工具注册 ───────────────────────────────────────────────

export type AgentTool = {
  /** 工具名（LLM 调用时用） */
  name: string;
  /** 工具描述（给 LLM 看的） */
  description: string;
  /** 输入参数的 JSON Schema（标准格式，跨 provider 通用） */
  inputSchema: object;
  /** 工具执行体 */
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
  /**
   * 只读硬约束声明位（只读重构 · 声明式统一拦截）。`true` = 此工具**恒**改持久状态
   * （git 历史 / 用户数据 / 落盘 / 装 MCP·plugin·skill 等），只读挡下由 executeAgentTool 在
   * 触达 execute 前直接拒。必填、无默认——逼每个工具显式分类，新写工具忘标即编译错，杜绝静默放行。
   *
   * 标 `false` 的三类：① 纯读/会话级/渲染（read_file / activate_plugin / render_html 等）
   * ② **条件**变更——bash 按 isReadOnlyCommand 运行时判（只读挡仍允许 ls/cat），不能交给本闸无条件
   *   拒，否则只读挡下连环顾四周都做不到，故 false、在 proposeOrExecute 内自判。
   * ③ 委托给 proposeOrExecute 全审批流水线的工具——文件写（write/edit/manage_files）虽恒写，但它们
   *   把提案卡 / 破坏性确认 / 只读拒整条审批生命周期都交给 proposeOrExecute 统一拥有，故 false：
   *   只读拒只是那条流水线的一个切面，不该单独剥出来给本闸（剥出会把同一工具的审批逻辑劈成两处）。
   */
  mutatesEnvironment: boolean;
  /**
   * v0.4 落盘策略——决定 stream.ts 是否把这个工具的 result.detail 落到 .tool-cache/。
   * - 'never'：永不落盘（read_file / read_memory / ask_twin / escalate_to_user 等"全文型"工具，
   *   避免 read → persist → 再 read 死循环）
   * - 'always'：永远落盘（web_fetch——网页常 100KB+，规则化预期最稳）
   * - 'auto'（默认）：detail 估算超 2k token 时才落
   */
  persistPolicy?: 'never' | 'always' | 'auto';
  /**
   * v0.4 落盘文件扩展名（不含点）。默认 'txt'；例：web_fetch = 'md'（已转 markdown）。
   * 常量字段；如未来有"按入参/结果选扩展名"用例再升级为函数。
   */
  persistExt?: string;
};

/**
 * 「继承组」——必须从主对话**成组继承**到对话期 subagent 的 ToolContext 子集。
 * （多数字段原样透传；个别到达 subagent 后可被消费方 override，如 onProposal 被包装注入
 * triggeredBySubagent，见 subagentChat/runner.ts——组保证的是「字段到达」，不排斥再包一层。）
 *
 * 为什么单独成一个结构化子对象（2026-07-22 盘点 M5）：这些字段要在三处装配点
 * （主 ctx 装配 / RunSubagentDeps / subagent ctx 装配）保持一致，原本是人肉对齐的
 * 三份手抄清单——漏传不报错、只是工具静默失能（曾经的「修分叉」注释即实证）。收敛成组后：
 *   - `ToolContext = InheritedToolContext & { …其余 }`，故往组里加字段会**自动**同时进
 *     ToolContext（工具能读）和 `RunSubagentDeps.inherited`（subagent 整组 `...deps.inherited`
 *     透传）——加第二个消费者零成本，漏传在结构上不可能。
 *   - 组的定义源唯一在此，不再有第二份可漂移的字段清单（故别处注释不再逐字段复述，指此为准）。
 *
 * 判据（什么进组）：主对话与 subagent **同源、成组继承、缺了工具静默失能**的可选项。
 * 不进组：① 主/子发散的（`usage` 主子不同、`abortSignal` subagent 用 derived signal）
 * ② 必填标识（`conversationId` 等，漏传本就编译红，无静默失能之虞）
 * ③ 主对话独有（`runSubagent` 嵌套保护；`onTodoUpdate` / `onCommandOutput` / `boardCurrentTaskId`
 *    / `deckPath` 绑主对话 UI/messageId；`conversationCreatedAt` 服务 read_skill 回声防护，subagent
 *    单次响应不自创即用故不适用）④ subagent 独有（`browserSessionId` / `taskId` / `askTwinResolver`）。
 *
 * ⚠️ 组内**除 activatedPlugins 外均为回调**——同引用透传天然无副作用。activatedPlugins 是可变 Set，
 * 整组 spread 让主/子 ctx 持有**同一引用**；这安全**仅因** subagent 同步阻塞派工、期间主对话不并发
 * 跑工具（activate_plugin 的 `.add()` 是幂等写 + chip 落盘兜底）。**再往组里加第二个可变数据字段前，
 * 必须重新验证这个并发前提**——别照 activatedPlugins 的先例盲加。
 */
export type InheritedToolContext = {
  /**
   * Twin 通过 record_memory 写新记忆时由 tool 主动调，让上层把信息推到 UI（聊天流卡片）。
   * 不挂 → tool 静默工作，不会有 UI 通知。
   */
  onMemoryRecord?: (payload: MemoryRecordPayload) => Promise<void>;
  /**
   * 当天首次要改某个非 git 项目时由 maybeShowGitHint 调，让上层在对话流落一条
   * 「改动难以一键回退」的提示条。提示文案与项目无关、固定，故回调不带数据。
   * 不挂 → 静默工作（背景 query / 无 UI 场景）。
   */
  onGitHint?: () => Promise<void>;
  /**
   * AI 显式收尾工具（artifact_finalize_submission）收尾成功后由 tool 主动调，
   * 让上层广播该 artifact 的组状态变化（标注列表 + 提交组转完成 + HTML 热重载）。
   * 不挂 → 工具静默改盘，不通知 UI。
   */
  onArtifactSubmissionChanged?: (artifactId: string) => Promise<void>;
  /**
   * Twin 通过 propose_action 工具递交提案时由 tool 主动调，让上层广播给 UI / queue。
   * 不挂 → 提案能成但前端拿不到事件（背景 query 场景应不挂以避免错位 emit）。
   *
   * 对话期 subagent：主对话 runner 拼的这个 callback 随继承组透传给 subagent 自己的
   * ToolContext——subagent 调 propose_action 时通过同一 callback broadcast 到主对话流，
   * 审批弹窗显示在主对话。subagent runner 会把它包装一层注入 triggeredBySubagent
   * 让前端区分（见 subagentChat/runner.ts 的 wrappedOnProposal）。
   */
  onProposal?: (proposal: ActionProposal) => Promise<void>;
  /**
   * 留痕卡通道：装卸类在**不需要审批**时（全放挡 / 已持久授权）执行完，经此把一张只记录
   * 「装了什么」的**终态**卡推到对话流。全放挡下这些操作不弹审批卡，界面痕迹会归零——
   * MCP 三件套连 chip 都没有，卡片上明文展示 env / API key 供用户过目那一屏尤其保不住。
   *
   * 与 onProposal 分开而不是复用：那条链承载「审批请求」语义，渠道侧会把它拦成等确认
   * （channelOutbound），而留痕卡不是请求、也不该投影到远程（全放挡本就是用户亲手给的全量授权）。
   * 不挂 → 工具静默工作，不留卡（背景 / 无 UI 场景本就无处呈现）。构造与落点判据见 emitTraceCard。
   */
  onProposalTrace?: (proposal: ActionProposal) => Promise<void>;
  /**
   * 装卸类执行完成（成败都）后由工具主动调，让上层把「装了什么 / 为什么没成」落成对话流 chip
   * ——它进 conversation JSONL，重启后仍在，是比卡片（内存态）更长久的那份痕迹。
   * 上层的实现即 chip 的唯一落点（proposals/outcomeChip），与无工具在等时的独立执行器共用。
   * 不挂 → 工具静默工作，不落 chip。
   */
  onProposalOutcome?: (proposal: ActionProposal, outcome: ProposalOutcome) => Promise<void>;
  /**
   * 主对话用：ask_user_choice 工具弹「带选项提问」卡片时调此回调把卡片广播给前端（与 onProposal 同构）。
   * 只负责 emit chat.askUserChoice；挂 waiter / await 回答 / abort 都在工具 execute 内用 ctx.abortSignal
   * 完成（见 askUserChoice.ts，仿 emitProposal）。不挂（背景 Twin / runOneShot）→ 工具优雅 isError。
   * 对话期 subagent 也继承它（G72）：ask_twin 答不上时据此升级为用户提问卡。
   */
  askUserChoice?: (req: { askId: string; questions: AskUserChoiceQuestion[] }) => Promise<void>;
  /**
   * 工具断路器跳闸（G01/G04）：调用频率异常或连续失败达阈值时，executeAgentTool 经此 emit
   * 跳闸卡到主对话，随后阻塞等用户点「继续放行 / 停止」。只负责广播卡片（挂 waiter / await /
   * abort 在 circuitBreakerGuard 内用 ctx.abortSignal 完成，仿 askUserChoice）。
   * 不挂（背景 query / 无 UI）→ 断路器不阻塞、放行（背景路径靠停滞看门狗 + 预算线兜底）。
   */
  onCircuitBreak?: (req: {
    breakerId: string;
    conversationId: string;
    reason: 'consecutive-failures' | 'high-frequency';
  }) => Promise<void>;
  /**
   * 当前 conversation 已激活的 plugin id 集合（来源：扫 chat 流的 plugin-activate 消息重建）。
   * activate_plugin 工具调用时：已存在则幂等返回；不存在则加入并写一条 plugin-activate chip。
   * read_skill 工具调用 plugin 内 skill 时校验该 set——未激活就报错让 LLM 先 activate。
   * 不在 Conversation 类型里加字段——避免元数据膨胀；每轮拼 ToolContext 时由 runner 从 chat 流重建。
   * 继承给 subagent（否则 subagent 的 read_skill 校验拿不到激活态，skill 工具继承了却用不了）。
   */
  activatedPlugins?: Set<string>;
  /**
   * Skill 模块 v1：activate_plugin / read_skill 等工具调用时，主动调此 callback
   * 把 plugin-activate / skill-call chip 推到 chat 流（持久化 + broadcast）。
   *
   * 不挂 → 工具静默工作，不会有 chip 通知（runner 重建激活态会拿不到——降级容忍）。
   */
  onSkillEvent?: (payload: SkillEventPayload) => Promise<void>;
};

export type ToolContext = InheritedToolContext & {
  conversationId: string;
  agentId: string;
  ownerId: string;
  activeProjectId?: string;
  /**
   * 当前 agent 的审批挡位快照——来自 agent.approvalMode。承重判定已改为 emitProposal 实时
   * getAgent（本字段仅 agent 已删的死角回落）。现行三挡：
   *   readonly → 只读放行、写类直接拒
   *   work     → 破坏性（forceApproval）才弹卡，只读直接执行
   *   danger   → 全放，仅火灰断路器（catastrophic）弹卡（未持久授权直通、不落清单）
   */
  approvalMode: ApprovalMode;
  /**
   * 当前对话的 LLM 用途；factory 注入工具时填入。
   * web_search/web_fetch 内部的长摘要 summarizer 据此选择对应 backend。
   * dream / conversationSummary 走 runOneShot 不构造 ToolContext，因此本字段在那里不可见。
   */
  usage: LlmUsage;
  /**
   * 当前对话的中断信号；用户取消对话时立刻 abort 工具内部的 HTTP 请求 / runOneShot 调用。
   * 来源：ConversationInput.abortController.signal。
   */
  abortSignal: AbortSignal;
  /**
   * 搜索预算桶 id（决策二：子 agent 用独立配额，不占主对话）。
   * web_search/web_fetch 用 `searchBudgetId ?? conversationId` 计预算——
   * 子 agent 传独立 id（与主对话 conversationId 区分），存量路径不传则回落到 conversationId。
   * 由联网能力的 initRuntime 注入（见 capabilities/builtins/webSearch.ts）。
   */
  searchBudgetId?: string;
  /**
   * 浏览器操控会话桶 id（S33）。browser_* 六件用 `browserSessionId ?? conversationId` 入桶——
   * 对话期 subagent 的 conversationId 与主对话相同（审批卡路由需要），若不另给桶 id，
   * subagent 与主对话会抢同一个「当前页」（任一方 navigate 清掉另一方页面态）。
   * 与 searchBudgetId 同款模式：subagent 传 `subagent_${taskId}`，存量路径回落 conversationId。
   */
  browserSessionId?: string;
  /**
   * 主 agent 调 Task 工具派出对话期 subagent 时的 callback；不挂 → Task 工具不可用。
   * 由主 runner 在拼 ToolContext 时挂，闭包捕获 onProposal / stableSystemContext /
   * abortController / 主对话广播 hook 等 deps，转交 subagentChat/runner.ts。
   * subagent 的 ToolContext **不**挂此字段（嵌套保护：subagent 不能再派 subagent）。
   */
  runSubagent?: (req: { description: string; prompt: string }) => Promise<ToolResult>;

  // ─── 背景 Twin / 子 agent 用的 task 上下文 ──────────────────────
  /** 当前任务 id（背景 Twin 处理子 agent 反问 / 子 agent 自己跑时设置） */
  taskId?: string;
  /**
   * Deck 任务专属：当前 deck 目录（含 index.html + images/）。
   * 由 subagentRunner 在 proposal.deckContext 存在时注入；render_contact_sheet / view_slide
   * 据此取页渲染。非 deck 任务为 undefined → 两个工具调用时优雅 isError 拒绝。
   */
  deckPath?: string;
  /**
   * 背景 Twin 用：escalate_to_user 工具调用此 handler 把问题转给用户。
   * 不挂 → escalate_to_user 工具不应被注册到该 backend。
   */
  escalateHandler?: (taskId: string, question: string) => Promise<void>;
  /**
   * 子 agent 用：ask_twin 工具调用此 resolver 由背景 Twin 回答；返回 Twin 的回答字符串。
   * 不挂 → ask_twin 不可用。
   */
  askTwinResolver?: (taskId: string, question: string, contextPaths: string[]) => Promise<string>;
  /** 子 agent 用：report_progress 工具调用此 emit 把"在干啥"推到 UI 卡片状态行。 */
  progressEmit?: (text: string) => void;
  /**
   * 通用 todo（计划清单，S32·G49）：AI 调 todo 工具更新计划清单时调此回调，上层 broadcast chat.todo 给前端
   * 展示。不挂（背景 query / 无 UI）→ 工具仍存清单、回执给 AI，只是不推 UI（纯展示、丢了不影响判定）。
   */
  onTodoUpdate?: (items: TodoItem[]) => void;
  /**
   * Loop 拆解受限回合（usage='loopCompile'）专用：submit_checklist 工具校验通过后经此把
   * 验收标准清单交回 compileChecklist（工具纯数据提交、无副作用，结果不走对话历史回传）。
   * 只在拆解回合装配时挂；不挂 → submit_checklist 优雅 isError（装配错误要能看见）。
   */
  onChecklistSubmit?: (items: ChecklistItem[]) => void;
  /**
   * 前台 bash 长命令执行期间的实时输出回调（S19·G19）：每有一段新 stdout/stderr 就调，
   * 上层 emit chat.commandOutput 推给 UI 滚动显示（只给人看，不喂模型——模型到 tool_result 才拿到）。
   * 不挂 → 静默（子 agent / 背景 query / 无 UI 场景，命令仍照跑，只是没有实时流）。
   */
  onCommandOutput?: (chunk: string) => void;

  // ─── 任务评论场景 ────────────────────────────────────────────
  /**
   * 评论场景注入：当前评论线挂在哪个 BoardTask 下。
   * delete_task 工具据此守卫"不能在自身评论里删自己"——避免破坏当前评论线。
   * 主聊天场景永远 undefined（主聊天没有"当前 task"语义）。
   * 实际注入由 PR-D（评论 runner 改造）完成。
   */
  boardCurrentTaskId?: string;

  // ─── Skill 模块（v1）───────────────────────────────────────────
  // 注：activatedPlugins / onSkillEvent 属「继承组」，定义见上方 InheritedToolContext。
  /**
   * 当前 conversation 的 createdAt（毫秒）。read_skill 工具用它做回声防护——
   * skill.availableFromTimestamp > createdAt 时拒绝读（避免分身刚自创 skill 立即被自己用）。
   */
  conversationCreatedAt?: number;
};

/** Skill 模块 v1：onSkillEvent callback 入参 */
export type SkillEventPayload =
  | { kind: 'plugin-activate'; pluginId: string; name: string }
  | { kind: 'skill-call'; skillId: string; name: string };

/**
 * 工具回传给模型"看"的图像（render_html 的截图走这里）。
 * 本期只产 PNG——capturePage().toPNG() 是全代码库唯一的图像编码路径；真有别的格式再加，不预先铺宽。
 */
export type ToolResultImage = {
  /** base64，不含 "data:image/png;base64," 前缀 */
  base64: string;
  mediaType: 'image/png';
};

export type ToolResult = {
  /** 是否错误（错误时 LLM 看到 isError=true） */
  isError?: boolean;
  /** 工具结果文本（LLM 看到这个） */
  text: string;
  /**
   * 结构化元数据；落盘到 shared/types.ts 的 ToolResult.structured。
   * 只走 Oru 内部协议（ConversationEvent.tool_result.structured）回到 stream.ts，
   * 不会塞进发给 LLM 的 prompt——LLM 看到的还是 text。
   */
  structured?: Record<string, unknown>;
  /**
   * 工具回传给模型"看"的图像。缺省/空 = 纯文字结果——现有所有工具都不填，行为零变化（向后兼容）。
   * 仅走 sdk-mcp 协议的 backend（claude-code）当前消费它，转成 MCP image content 喂回模型；
   * 其它 backend 暂不消费（见 render_html 技术设计 §6 兼容性）。
   */
  images?: ToolResultImage[];
};
