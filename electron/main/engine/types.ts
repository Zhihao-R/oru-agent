/**
 * 代码执行引擎抽象层 — 中性接口
 *
 * 这个接口的目的是把"调度 LLM 跑代码 / 工具调用"这件事抽象出来，
 * 让业务代码不直接依赖某个具体厂商的 SDK。
 *
 * 当前默认实现是基于 Claude Agent SDK（见 ./claudeAgentSdk.ts）；
 * 未来想换底层（OpenCode / Cursor / 自研）只换实现，业务代码不动。
 *
 * 设计原则：
 * - 类型名和字段名用中性术语，不照搬 SDK 命名
 * - 只暴露当前业务用到的能力，不为未来 hypothetical 扩展过度抽象
 * - MCP 工具的形态跟 SDK 紧密耦合（zod schema / 返回 content 等），
 *   第一版作为"engine.mcp 透传"——已知的伪抽象，未来真要换底层时再处理
 */

// ─── Run 入口 ───────────────────────────────────────────────

export type EnginePermissionMode = 'bypass' | 'standard';

export type EnginePresetSystemPrompt = {
  type: 'preset';
  /** 当前唯一可选；未来如果支持别的预设再扩 */
  preset: 'claude_code';
  append?: string;
};

export type EngineHookContext = {
  eventName: 'UserPromptSubmit' | 'SessionStart';
};

export type EngineHookResult = {
  additionalContext?: string;
};

export type EngineHookHandler = (ctx: EngineHookContext) => Promise<EngineHookResult | void>;

/**
 * 工具闸门钩子（PreToolUse）：每次模型要调一个工具前先问它，返回 deny 则拦下、该工具不执行。
 * 在权限层之前生效，故不受 permissionMode:'bypass' 影响——这是用来在只读挡硬拒 SDK 内置写工具
 * （Write/Edit…，不经 Oru 提案闸、bypass 又旁路了 disallowedTools）的唯一可靠手段。
 * 返回 void / { deny:false } = 放行。
 */
export type EngineToolGateHandler = (
  toolName: string,
) => Promise<{ deny: boolean; reason?: string } | void>;

/**
 * PostToolUse 观察者：工具成功执行后收到通知（工具名 + 原始入参），纯旁路——
 * 返回值不回注模型、抛错不打断回合。当前唯一消费者：SDK Read 的认知同步（S02 · D2）。
 */
export type EngineToolObserverHandler = (toolName: string, toolInput: unknown) => Promise<void>;

/**
 * MCP server 实例 — 第一版透传 SDK 的形态。
 * 通过 engine.mcp.createServer(...) 创建。
 */
export type EngineMcpServer = unknown;

/**
 * 多模态 prompt 的单个内容块（中性形态，不照搬 SDK 类型）。
 * 仅当一轮输入需要带图片时用数组形态；纯文本仍直接用 string。
 */
export type EnginePromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; base64: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' };

export type EngineRunInput = {
  /**
   * 用户输入 / 待跑的提示。
   * - string：纯文本，走 SDK 单条 string prompt。
   * - EnginePromptBlock[]：多模态单条 user 消息（文+图），走 SDK streaming input。
   *   与 resume 不冲突——带图轮照常续传，不影响 session 生命周期。
   */
  prompt: string | EnginePromptBlock[];
  /** 工作目录 */
  cwd: string;
  /** 调用方持有的 abort signal */
  abortController: AbortController;
  /** 续传 session id（由上次 'session_id' 事件给出） */
  resume?: string;
  /** systemPrompt 配置 */
  systemPrompt: EnginePresetSystemPrompt;
  /** 是否加载 user / project / local 三层 settings（含 CLAUDE.md） */
  loadSettingSources?: boolean;
  /** 权限模式：bypass = 不弹权限对话框（适用于 Twin / 子 agent），standard = 标准 */
  permissionMode: EnginePermissionMode;
  /** 显式允许的工具白名单（不传则跟随默认） */
  allowedTools?: string[];
  /** 禁用工具黑名单 */
  disallowedTools?: string[];
  /**
   * 引擎自带内置工具的"基集"（如 Read / Write / Edit / Bash 等）：
   * - undefined：默认全量（行为不变）
   * - []：全部禁用——只读白名单回合用，模型根本看不到内置工具
   * - 非空数组：只开列出的内置工具（当前无调用方，语义随底层 SDK）
   * 与 allowedTools 的区别：allowedTools 在 SDK 语义里只是"免权限确认"，不是可见性收口；
   * 本字段才是从模型上下文里移除工具的开关。不影响 mcpServers 挂载的工具。
   */
  builtinTools?: string[];
  /** 挂载的 MCP servers，key 是 namespace */
  mcpServers?: Record<string, EngineMcpServer>;
  /**
   * 钩子：UserPromptSubmit / SessionStart（附加 context）+ PreToolUse（工具闸门，可拦下工具）
   * + PostToolUse（纯观察，不影响执行）。
   */
  hooks?: {
    onUserPromptSubmit?: EngineHookHandler;
    onSessionStart?: EngineHookHandler;
    onPreToolUse?: EngineToolGateHandler;
    onPostToolUse?: EngineToolObserverHandler;
  };
  /** 子进程环境变量（包括 ANTHROPIC_API_KEY 等） */
  env?: Record<string, string | undefined>;
  /**
   * 指定具体 model id（如 'claude-sonnet-4-6' / 'claude-haiku-4-5'）。
   * 不传则用 SDK 默认（当前 Sonnet 4.6）。
   */
  model?: string;
  /**
   * 思考（thinking）token 上限；0 = 关掉自适应思考（随手评点的思考开关用）。
   * 不传 = SDK 默认（模型自适应决定想不想）。语义实测见 claudeAgentSdk.ts 的 toSdkOptions 注释。
   */
  maxThinkingTokens?: number;
  /**
   * Steering 活流模式（claude-code 近似中途转向）：true 时输入走**持续开着**的 streaming-input——
   * 首条 prompt 起跑后流不关闭，handle.appendInput 可继续推入新 user 消息起新轮、handle.interrupt
   * 可截断当前轮。仅主对话 steering 用；不传 = 现状单发（string / 单 yield streaming），行为零变化。
   * 实测机制见 docs/tech/2026-06-15-busy-message-queue-spike-findings.md（v5）。
   */
  live?: boolean;
  /**
   * 逐 token 流式（SDK includePartialMessages）：true 时子进程额外吐 stream_event 增量，
   * adaptEvents 把 text_delta 转成逐段 assistant_text。**per-run 决策、不全局常开**——
   * 只有"用户在实时看输出"的路径（主对话 / subagent chat）才开；oneShot（摘要 / dream /
   * 背景 query 只取终值）不开，否则白付一整轮 token 增量穿子进程边界再丢弃的成本。
   * 不传 = 不开，SDK 只在每条 assistant 消息完成时吐整块文本（行为零变化）。
   */
  streaming?: boolean;
};

// ─── 流式事件 ────────────────────────────────────────────────

/**
 * 引擎抛出的中性事件流。
 * 业务代码（stream 模块）消费这个，不再 import SDKMessage。
 */
export type EngineEvent =
  /** 引擎给出新的 session id（首次或 compact 后） */
  | { type: 'session'; sessionId: string }
  /** assistant 输出一段文本（流式增量） */
  | { type: 'assistant_text'; text: string }
  /** assistant 调用了一个工具 */
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  /** 工具调用结果 */
  | {
      type: 'tool_result';
      toolUseId: string;
      isError: boolean;
      content: unknown;
      /** 工具上抛的结构化元数据（v0.2 web_search/web_fetch 用），落盘到 ToolResult.structured */
      structured?: Record<string, unknown>;
    }
  /** transport 层 retry 通知（OpenAI-compatible backend 用），stream.ts 透传成 ws chat.retrying */
  | { type: 'retrying'; attempt: number; maxRetries: number }
  /**
   * 单次 LLM 调用结束时的 token usage（debug 模块消费；stream / runner 忽略）。
   * Claude Agent SDK 不发此事件——claudeAgentSdk 引擎走不到这里，仅 anthropic / openaiCompat backend 透出。
   * 加在 EngineEvent 里只是为了让 ConversationEvent ⊆ EngineEvent 的子集关系成立——
   * stream.ts 等消费方默认 switch 落到 default 忽略。
   */
  | { type: 'llm_usage'; inputTokens?: number; outputTokens?: number }
  /** 全部跑完时的最终结果；usage 为整轮累计 token（debug 模块消费，填进 final_answer 汇总） */
  | {
      type: 'result';
      resultText: string | null;
      isError: boolean;
      usage?: { inputTokens?: number; outputTokens?: number; actualModel?: string };
      /** 本回合流过 reasoning（思考通道）delta——语义见 ConversationEvent 同名字段；claude 引擎不发 */
      sawReasoning?: boolean;
    };

export type EngineRunHandle = {
  /** 事件流；调用方 for-await 消费 */
  events: AsyncIterable<EngineEvent>;
  /**
   * Steering（claude-code 近似中途转向）：向活流追加一条 user 消息（多模态块），喂进 SDK 起新轮。
   * 仅 live 模式（EngineRunInput.live）的 run 提供；单发 prompt 路径为 undefined。
   * 落盘语义见技术方案原则 4：调用方须在 appendInput 投递**之前**完成落盘（消费=落盘那一刻）。
   */
  appendInput?: (blocks: EnginePromptBlock[]) => void;
  /**
   * Steering：截断当前轮（SDK interrupt），产出一个 error_during_execution result；
   * 已完成的 tool_result 保留进 session，仅 interrupt 那刻在途的单个工具被 abort（spike v5 实测）。
   * 仅 live 模式提供；单发 prompt 路径为 undefined。Esc 不用它——走既有 abortController.abort()。
   */
  interrupt?: () => Promise<void>;
};

// ─── MCP 工厂（透传） ────────────────────────────────────────

/**
 * MCP 工具定义的入口对象 — 第一版透传 SDK 的 createSdkMcpServer / tool。
 * 业务代码 (oruMcpFactory.ts) 通过 engine.mcp 拿到工厂函数。
 *
 * 类型用 unknown / any-ish 接住，因为 SDK 的具体类型签名（zod schema 推断、
 * tool callback 返回结构）很复杂，第一版不做类型层抽象。
 */
export type EngineMcpFactory = {
  /**
   * 创建一个 MCP server。
   * @param config name / version / tools[]
   */
  createServer: (config: {
    name: string;
    version: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: any[];
  }) => EngineMcpServer;
  /**
   * 定义一个 MCP tool。返回值要喂给 createServer 的 tools 数组。
   */
  defineTool: (
    name: string,
    description: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (input: any) => Promise<any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => any;
};

// ─── 引擎主接口 ──────────────────────────────────────────────

export interface CodeExecutionEngine {
  run(input: EngineRunInput): EngineRunHandle;
  /** MCP 工具相关；第一版透传 SDK */
  mcp: EngineMcpFactory;
}
