/**
 * ClaudeCodeBackend — AgentBackend 接口的第一个实现
 *
 * 内部用 `engine.run()`（→ Claude Agent SDK）。这个 backend 知道 MCP / SDK
 * 的细节，但**不让外部调用方感知**——外部只看到 AgentBackend 接口。
 *
 * 工作分工：
 * - runConversation：包装 engine.run，注入 ToolContext（工具自己拿 ctx.onProposal）+ 动态注册的 AgentTool
 * - runOneShot：包 engine.run 的非交互模式
 * - registerTool：把 AgentTool 收起来，runConversation 时合并到一个 'oru' MCP server
 */
import { z } from 'zod';
import type {
  AgentBackend,
  AgentTool,
  ConversationHandle,
  ConversationInput,
  OneShotInput,
  OneShotResult,
  ToolContext,
} from '@shared/agent/backend';
import { STEERING_SUPPLEMENT_PREFIX } from '@shared/agent/backend';
import { isExternalMcpToolName, normalizeToolName } from '@shared/agent/toolName';
import type { ChatAttachment, ChatMessage } from '@shared/types';
import { engine, PROCESS_EXIT_ERROR_RE } from '../../engine';
import type {
  EngineEvent,
  EnginePromptBlock,
  EngineRunInput,
  EngineToolGateHandler,
} from '../../engine/types';
import { retryStreamStart, DEFAULT_RETRY, type RetryConfig } from '../util/retry';
import { attachmentAbsPath, readAttachmentBase64 } from '../../conversations/attachments';
import { jsonSchemaToZodShape } from './jsonSchemaToZod';
import { detectAuth } from '../auth';
import { realtimeApprovalModeFor, getAgent } from '../store/agents';
import { getSettings } from '../../projects/store';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { t } from '../../i18n/t';
import { executeAgentTool } from '../agentTools/approvalGate';
import { stashToolStructured } from '../agentTools/toolStructured';
import { makeSdkReadRecorder } from '../sdkReadCognitionSync';
import {
  adaptHistory,
  isInferenceViewEnabled,
  type NormalizedMessage,
} from './historyAdapter';
import { SessionPoisonError, isSessionPoisonText } from './sessionPoison';

/**
 * 会话污染检测（G54）——扫描事件流：本次 resume 在用、本回合尚未产出任何 assistant 内容、
 * result 事件 isError 且文案匹配毒化模式 → 不 yield 该 result，改抛 SessionPoisonError。三条件在
 * backend 一次判齐（它最清楚 resume 与产出状态），错误文本因此不会被 stream 兜底成 delta、
 * runner 的 streamingStarted 不被误置，重试 catch 能干净接住清号重灌。
 *
 * fail-closed：非 resume / 已产出 assistant / 文案不匹配 → 照常 yield result，普通报错不被吞。
 */
export async function* detectSessionPoison(
  events: AsyncIterable<EngineEvent>,
  resumeInUse: boolean,
): AsyncGenerator<EngineEvent> {
  let producedAssistant = false;
  for await (const ev of events) {
    if (ev.type === 'assistant_text' && (ev.text ?? '').trim().length > 0) producedAssistant = true;
    if (ev.type === 'tool_use') producedAssistant = true;
    if (
      ev.type === 'result' &&
      ev.isError &&
      resumeInUse &&
      !producedAssistant &&
      isSessionPoisonText(ev.resultText ?? '')
    ) {
      throw new SessionPoisonError(ev.resultText ?? '');
    }
    yield ev;
  }
}

/**
 * 条款闸误杀判定——SDK 自带 CLI 启动时对 OAuth 消费者账户复查消费者条款：并行拉账户
 * settings 与条款配置两个接口，settings 偶发失败（超时/限流）而条款配置成功且宽限期已过
 * → print 模式弹不出确认界面 → stderr 打 "[ACTION REQUIRED] …" 后 exit(1)。账户已接受
 * 条款也照样偶发误杀（fail-closed 上游缺陷，重新跑 `claude` 接受治不了）。
 *
 * 窄匹配：进程退出特征 + 条款闸文案（stderr 由 enrichProcessExitError 补进 message）。
 * 鉴权失败 / 模型不可用等确定性 exit 1 不在此列——重试它们只是拖慢报错。
 */
export function isTermsGateExit(e: unknown): boolean {
  return (
    e instanceof Error &&
    PROCESS_EXIT_ERROR_RE.test(e.message) &&
    e.message.includes('ACTION REQUIRED') &&
    e.message.includes('Consumer Terms')
  );
}

// 重试节奏比 DEFAULT_RETRY 快收口（[2,5,15]s × 3 次 ≈ 22s）：闸门死得快（spawn 后 1~3s），
// 且「真没接受条款」的确定性场景也会走满全部重试——不能让用户等 8 分钟才看到真错误。
const SPAWN_GATE_RETRY: RetryConfig = {
  ...DEFAULT_RETRY,
  maxRetries: 3,
  backoffScheduleSeconds: [2, 5, 15],
};

/**
 * spawn 阶段条款闸误杀自动重试——包在事件流最外层，每次重试重开整条链（重新 spawn 子进程）。
 * 复用 retryStreamStart 的「首事件前可重试」边界：闸门死在任何事件产出之前 → 零事件即重试，
 * 绝无内容重复；一旦流出过事件再死，原样抛（交续写 / 错误条），与 anthropic 后端同一条铁律。
 * 重试时向上 yield retrying 事件（stream.ts 转 chat.retrying，用户看到「正在重试」）。
 *
 * open 不接收 per-attempt signal（异于 retryStreamStart 的 openStream 签名）：子进程的中止
 * 走 engineInput.abortController，与这里的 signal 同源，闭包自带——不要给 open 加 signal 参数。
 */
export async function* withSpawnRetry(
  open: () => AsyncIterable<EngineEvent>,
  signal: AbortSignal,
  cfg: RetryConfig = SPAWN_GATE_RETRY,
): AsyncGenerator<EngineEvent> {
  for await (const item of retryStreamStart(open, isTermsGateExit, cfg, signal)) {
    if (item.kind === 'retrying') {
      yield { type: 'retrying', attempt: item.attempt, maxRetries: item.maxRetries };
    } else {
      yield item.event;
    }
  }
}

/**
 * 只读硬约束补全（只读重构 · playtest 补缺口）：以下两类工具不经 Oru 提案闸，且 permissionMode:'bypass'
 * 旁路了 disallowedTools——只能用 PreToolUse 钩子拦。只读挡下实时拒，覆盖对话分身 + 后台 subagent 两条
 * claudeCode 线，与 Oru 工具的只读拒同一道承诺：
 *  1. SDK 内置写工具（Write/Edit…）+ Bash——Bash 已在 disallowedTools，这里兜底防 SDK 版本漂移。
 *  2. 外部 MCP server 工具：看不透会不会写盘/改环境，按只读 fail-closed 一律拒（与 isReadOnlyCommand
 *     白名单同立场——证不了只读就不放）。外部 MCP 改走反射后（2026-07-27）它们已有 AgentTool、
 *     会先经 executeAgentTool 的中央闸按 mutatesEnvironment 拒，这里是第二道纵深：SDK 版本漂移、
 *     或将来又出现不经中央闸的工具面时仍拦得住。SDK 读工具（Read/Glob/Grep）不触发挡位读取。
 */
const SDK_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

function isReadonlyGuardedTool(toolName: string): boolean {
  if (SDK_WRITE_TOOLS.has(toolName)) return true;
  // 先归一再判：反射工具桥进 'oru' 后 wire 名是 mcp__oru__mcp__<serverId>__<tool>，
  // 直接判会因外层 mcp__oru__ 前缀误认成 Oru 自有工具而放行（前缀致精确匹配静默失效的老形态）。
  return isExternalMcpToolName(normalizeToolName(toolName));
}

/**
 * SDK 0.1.77 内置工具全集——真机抓自 `SDKSystemMessage(subtype:'init').tools`
 * （preset claude_code + settingSources 隔离，重抓脚本见 scripts/captureBuiltinTools.mts）。
 * 这是**冻结快照**：SDK 升级新增的内置工具不在此 → 默认路径不可见（fail-closed）。
 * ⚠ 升级 SDK 时重跑抓取脚本，按差异更新本清单 + 复核新工具该不该放进 allowlist。
 */
const SDK_BUILTIN_TOOLS_0_1_77 = [
  'Task', 'TaskOutput', 'Bash', 'Glob', 'Grep', 'ExitPlanMode', 'Read', 'Edit',
  'Write', 'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'KillShell',
  'AskUserQuestion', 'Skill', 'EnterPlanMode', 'LSP',
] as const;

/**
 * 默认路径（主对话 / subagent chat / subagentCoder）禁掉的内置工具——allowlist 与 disallowedTools 的单一来源。
 * - Bash：raw shell 走 Oru 的 mcp__oru__bash 提案闸，不放 SDK 原生 Bash。
 * - Write / Edit（S02 写入路径收口）：SDK 子进程直落磁盘，不进 per-file 锁、不留 overwrite-guard
 *   快照、无 'ai' 事件标、无带 filePath 的 fs.changed 广播；写一律走 mcp__oru__write_file/edit_file
 *   守卫链（实施方案 docs/tech/2026-07-10-s02-ai写入路径收口实施方案.md）。
 * - Task：Oru 有自己的 subagent 机制（mcp__oru__ 工具 / proposeOrExecute），不接管 SDK 的 Task。
 * - NotebookEdit：写工具，不放。
 * - AskUserQuestion：改由 provider-agnostic 的 ask_user_choice 接管（弹卡 / 答案回流）。
 * - TaskOutput / KillShell：后台进程的伴生子操作（读输出 / 杀 shell）。其发起工具 Bash/Task 都已 deny
 *   → 无合法前置、永不可成功调用；一并 deny 让黑名单覆盖完整子系统、allowlist 不留死工具面（D3-a review）。
 */
export const DEFAULT_DENIED_BUILTINS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Task',
  'AskUserQuestion',
  'TaskOutput',
  'KillShell',
  // S04 网络出口收口（G74）：SDK 内置抓取/搜索结构性关死——联网能力启用时由 oru 版
  // web_fetch/web_search 提供（投递闸、预算、注入检测都长在那里）；能力未启用时不留裸出口。
  'WebFetch',
  'WebSearch',
  // 以下两类都关，但理由不同——别当「跟着一起关」：
  // ① 有 provider-agnostic 自有替代（重复路径，关原生逼模型走会上屏/受治理的那条）：
  // Skill：Oru 的 skill 只登记在自有 read_skill / activate_plugin（skillModule.ts），走回声防护 +
  //   chip + 审批；SDK 原生 Skill 看不见它，且默认路径 loadSettingSources:true 会灌进用户全局
  //   ~/.claude/skills 与插件 skill，绕过 Oru 治理。留着只会让模型偶尔点原生版报 "Unknown skill"。
  'Skill',
  // TodoWrite：改由自有 todo（agentTools/todo.ts）接管——写 todoStore 推 UI 渲染；原生 TodoWrite
  //   写 SDK 内部态、Oru 不渲染 → 幽灵清单。todo 覆盖 twinMain/twinSubagent(继承)/subagentCoder。
  'TodoWrite',
  // ② 未接线的 SDK 交互工具（暂无替代）：Oru 无 plan-mode UI、engine 不处理其事件，留着是裸噪音面。
  //   同 AskUserQuestion 的「不接管 SDK 交互工具」立场（区别：AskUserQuestion 已有 ask_user_choice
  //   替代，PlanMode 暂无——未来若要接由 provider-agnostic 版提供）。
  'EnterPlanMode',
  'ExitPlanMode',
] as const;

/**
 * 默认路径内置工具门 allowlist = 全集快照 ∖ DEFAULT_DENIED_BUILTINS（配方见 docs/tech/2026-06-24-d3a-*.md §3）。
 * 「全集减黑名单」而非「枚举用到的」：非回归（今天可用的每个工具都仍在）+ fail-closed
 * （未来 SDK 新增、不在全集快照里的内置工具不暴露）。取代原 `builtinTools: undefined` 的 fail-open。
 */
const BUILTIN_ALLOWLIST: string[] = SDK_BUILTIN_TOOLS_0_1_77.filter(
  (t) => !(DEFAULT_DENIED_BUILTINS as readonly string[]).includes(t),
);

/** 构造 PreToolUse 闸门：只读挡下拒 SDK 写工具 + 外部 MCP 工具。挡位每次工具调用实时读（中途切只读即时生效）。 */
export function makeReadonlyWriteGate(ctx: ToolContext): EngineToolGateHandler {
  return async (toolName) => {
    if (!isReadonlyGuardedTool(toolName)) return; // 与只读无关的工具（SDK 读工具 / oru 工具）不读挡位
    const mode = await realtimeApprovalModeFor(ctx.agentId, ctx.approvalMode);
    if (mode !== 'readonly') return;
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    const name = (await getAgent(ctx.agentId).catch(() => null))?.name || 'Oru';
    return {
      deny: true,
      reason: t('main:approval.readonlyWriteDenied', lang, { tool: toolName, name }),
    };
  };
}

export class ClaudeCodeBackend implements AgentBackend {
  readonly backendType = 'claude-code' as const;
  readonly toolProtocol = 'sdk-mcp' as const;
  readonly modelId?: string;
  readonly providerId?: string;
  /** 通过 registerTool 注册的工具 */
  private readonly tools = new Map<string, AgentTool>();
  /** factory 实例化时传入的默认 model id；为空走 SDK 默认 */
  private readonly defaultModel?: string;
  /** 当前 model 是否支持视觉——决定要不要把本轮用户上传的图喂进模型 */
  private readonly supportsVision: boolean;
  /**
   * SDK 子进程 env（factory 构造期经 resolveSubprocessEnv 解析注入）——本后端独有：
   * 剥掉劫持用的 ANTHROPIC_BASE_URL、按鉴权模式补 ANTHROPIC_API_KEY。HTTP 两后端不需要 env，
   * 故它收进本后端而非 ConversationInput（原散在 7 个调用方，M4 收口）。空 = SDK 继承进程 env。
   */
  private readonly env?: Record<string, string | undefined>;

  constructor(
    defaultModel?: string,
    opts?: {
      modelId?: string;
      providerId?: string;
      supportsVision?: boolean;
      env?: Record<string, string | undefined>;
    },
  ) {
    this.defaultModel = defaultModel;
    this.modelId = opts?.modelId;
    this.providerId = opts?.providerId;
    this.supportsVision = opts?.supportsVision ?? false;
    this.env = opts?.env;
  }

  runConversation(input: ConversationInput): ConversationHandle {
    // 续传策略：
    // - 已有 sdkSessionId 且最近一条 assistant 也是 claude-code → 走 SDK 原生 resume
    // - 无 sdkSessionId 但 history 非空 → 灌历史成首条 prompt（用户首次切到本 backend）
    // - 有 sdkSessionId 但最近一条 assistant 是 anthropic / openai → sessionId 已过期
    //   （中间在别的 backend 跑了几轮，SDK 看不到那些）→ 强制重新灌历史
    // 没这套保护，从 anthropic / openai-compatible 切回 claude-code 时 Twin 会失忆

    // 随手评点（aside）只读白名单回合：restrictToolsTo 存在时在工具列表层面收口——
    // 白名单之外的工具让模型根本看不到（半措施如摘回调挡不住信任模式直通执行）。
    // 两个面：① oru MCP server 只桥白名单工具（外部 MCP 的反射工具是 mcp__* 注册名，按裸名的
    //   白名单自然滤掉——原「不透传外部 MCP server」那一面随透传退场并入此面）② 禁全部 SDK 内置工具。
    // 白名单用裸名（read_file）在桥接前过滤——SDK 给桥名加 mcp__oru__ 前缀是之后的事，
    // 故无需名字映射。（教训：裸名透传 SDK 的 allowedTools/disallowedTools 会静默失效。）
    const restrict = input.restrictToolsTo ? new Set(input.restrictToolsTo) : null;

    // 所有工具（含 propose_action / commit_changes / 记忆三件套等）都通过 factory 注册的 AgentTool
    // 桥接成 'oru' MCP server，统一命名空间——LLM 看到 mcp__oru__<tool>
    const mcpServers: Record<string, unknown> = {};
    const bridgedTools = Array.from(this.tools.values()).filter(
      (t) => !restrict || restrict.has(t.name),
    );
    if (bridgedTools.length > 0 && input.toolContext) {
      mcpServers['oru'] = this.buildToolsMcpServer(bridgedTools, input.toolContext);
    }
    // 外部 MCP server 不再走 SDK 原生透传（2026-07-27）：SDK 每回合新 spawn 一份子进程，
    // 下游按连接进程授权的资源（chrome-devtools → Chrome CDP）会因此每回合重弹授权框。
    // 改由 Oru 主进程长驻连接、反射成 AgentTool，跟着下面的 bridgedTools 一起桥进 'oru'——
    // 三个后端从此同一条路，进程也只剩长驻的那一份。详见
    // docs/plans/2026-07-27-外部MCP进程复用-实施plan.md。

    const sessionStale = isSessionStale(input.history);
    const effectiveResumeId = sessionStale ? undefined : input.resumeSessionId;
    // G54 污染检测只在 resume 在用时生效——fresh seed（无编号）的 400 是别的问题，不误判为污染。
    const resumeInUse = !!effectiveResumeId;
    const shouldSeedHistory =
      !effectiveResumeId && input.history && input.history.length > 0;
    // 续跑时 input.userMessage 为 undefined：取 history 末尾的 user 消息（多为「系统记」）作当前消息，
    // 既喂进 seed prompt 也喂进 SDK-resume 路径——否则 prompt 为 undefined、模型续不起来。
    const effectiveUserMessage = input.userMessage ?? lastUserText(input.history) ?? '';
    // fresh-run 随种子并入的点睛指代卡截图（seedReferentImageAttachments 注释详述）。
    // 先于 renderSeedPrompt 计算：seed 文本里这些附件的占位句必须改口为「已附上」——
    // 默认占位是「当前模型不支持视觉」，图明明在 prompt 里却被文本否认，模型会顺着文本
    // 拒绝认图（真机 smoke 实测：模型看得见图，仍答"我看不见截图"）。
    const seedImageAtts =
      shouldSeedHistory && this.supportsVision
        ? seedReferentImageAttachments(input.history!, input.userMessage)
        : [];
    const prompt = shouldSeedHistory
      ? renderSeedPrompt(
          input.history!,
          effectiveUserMessage,
          input.agentId,
          input.onInferenceView,
          seedImageAtts.length > 0
            ? new Set(seedImageAtts.map((a) => a.relPath))
            : undefined,
        )
      : effectiveUserMessage;
    if (!shouldSeedHistory) {
      // resume 路径：history 走 SDK 内部 session，historyAdapter 不参与，没有裁剪可言。
      // 仍调一次 onInferenceView 让 telemetry 知道这一轮发生过（savings 全 0），便于 ndjson 完整对账。
      // v0.5：adapterRan=false 显式标记"adapter 未跑"——UI 据此渲染 resume 降级提示。
      input.onInferenceView?.({
        enabled: isInferenceViewEnabled(),
        adapterRan: false,
        savings: {
          systemMessagesFiltered: 0,
          persistedReplaced: 0,
          persistedCharsReduced: 0,
          writeAckDeduped: 0,
          writeAckCharsReduced: 0,
          subagentChipsFiltered: 0,
        },
        wireHistory: [],
      });
    }

    const engineInput: EngineRunInput = {
      prompt,
      cwd: input.cwd,
      abortController: input.abortController,
      resume: effectiveResumeId,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: input.systemContext,
      },
      // 白名单模式不加载 settings——user/project settings 是工具引入面：项目 .mcp.json
      // 会挂 MCP server、skills/插件带 Skill 工具。SDK 不传 settingSources 即隔离模式。
      loadSettingSources: !restrict,
      permissionMode: 'bypass',
      // 默认黑名单：Bash / NotebookEdit / Task / AskUserQuestion。
      // 评论场景 caller 会传 ['Task', 'commit_changes']——必须**合并**而非覆盖
      // 否则评论场景反而开放 Bash 等危险工具
      // AskUserQuestion 是 SDK 内置交互工具：Oru 不接管它（弹不出卡、答案回不来），改由
      // provider-agnostic 的 ask_user_choice 工具接管，故在所有 backend 一律关掉它。
      disallowedTools: [...(input.disallowedTools ?? []), ...DEFAULT_DENIED_BUILTINS],
      allowedTools: input.allowedTools,
      // 内置工具基集（D3-a）：受限（aside 只读）→ []（结构性全关，范本）；默认 → BUILTIN_ALLOWLIST
      //（全集快照 ∖ denylist）。原 `undefined`（= SDK 全量）是 fail-open：SDK 升级新增写工具不在
      // denylist 即静默放行。改 allowlist 后未来新增工具默认不可见。上面的 disallowedTools 作第二层保险。
      builtinTools: restrict ? [] : BUILTIN_ALLOWLIST,
      mcpServers: mcpServers as Record<string, never>,
      hooks: {
        onUserPromptSubmit: input.onUserPromptSubmit
          ? async () => {
              const r = await input.onUserPromptSubmit!();
              return r ?? {};
            }
          : undefined,
        onSessionStart: input.onSessionStart
          ? async () => {
              const r = await input.onSessionStart!();
              return r ?? {};
            }
          : undefined,
        // 只读挡硬拒 SDK 写面（外部 MCP / 版本漂移兜底）——bypass 旁路了 disallowedTools，靠 PreToolUse 闸兜住。
        onPreToolUse: input.toolContext ? makeReadonlyWriteGate(input.toolContext) : undefined,
        // SDK Read 认知同步（S02 · D2）：读进守卫三的 fileState，SDK Read 与 read_file 一视同仁
        onPostToolUse: input.toolContext ? makeSdkReadRecorder(input.toolContext) : undefined,
      },
      env: this.env,
      model: input.model ?? this.defaultModel,
      // 逐 token 流式由调用方按"有没有人实时看"决定（见 ConversationInput.streaming）——
      // 主对话 / subagent chat 传 true，dream / 背景 query 不传。
      streaming: input.streaming,
      // 默认压掉自适应思考（maxThinkingTokens:0）治"慢"：SDK 实测默认 undefined 会非确定触发 thinking
      // 吃首字延迟（见 claudeAgentSdk.ts toSdkOptions 注释）。只有显式 disableReasoning===false
      //（aside 思考开关打开）才放开 → undefined。三态语义见 shared/agent/backend.ts。
      maxThinkingTokens: input.disableReasoning === false ? undefined : 0,
    };

    // token usage 由 engine/claudeAgentSdk.ts 从 SDK message 抽出：result 从 modelUsage 聚合
    // 出整轮累计 token + actualModel，填进 final_answer 汇总；本文件按子集关系透传，无需特殊处理。
    // 单次调用（per-call）token 暂不做——SDK assistant message 虽带 usage，但其消息边界与 debug
    // 的 LLM 调用边界不完全对齐，强行 per-call 会引入统计错位，故只做整轮（调试面板单步 token 显示 "—"）。

    // 本轮带图 + 模型支持视觉 → prompt 升级为多模态块（图在前、文在后，与 Anthropic 直连一致）。
    // streaming input 与 resume 不冲突：带图轮照常续传，不重开 session、不重灌历史。
    // 种子图（上面算好的 seedImageAtts）在前、当轮图在后，保持时间顺序。
    const imageAtts = this.supportsVision
      ? [...seedImageAtts, ...currentTurnImageAttachments(input.history, input.userMessage)]
      : [];

    // Steering 活流（claude-code 近似中途转向）：hasPendingSteering 挂着即开——仅主对话 chat.send 绑定，
    // subagent / oneShot / aside 都不挂 → 走下方单发路径、行为零变化。持续活流 + interrupt 驱动续喂的
    // 机制与 C1/M2/M3 处置见 docs/tech/2026-06-15-busy-message-queue-tech-design.md §5。
    // prompt 在此处恒为 string（renderSeedPrompt / effectiveUserMessage 都返回 string）；
    // 多模态块的拼装统一交给 buildPromptBlocks（steering 与 withImages 两路共用）。
    // 条款闸误杀重试包最外层：重试即重开整条链（重新 spawn + 重建污染检测的 per-attempt 状态）。
    // detectSessionPoison 的 SessionPoisonError 不匹配条款谓词 → 原样穿透，清号重灌逻辑不受影响。
    const retrySignal = input.abortController.signal;
    if (input.hasPendingSteering) {
      return {
        events: withSpawnRetry(
          () =>
            detectSessionPoison(
              runSteerableConversation(engineInput, input, prompt, imageAtts),
              resumeInUse,
            ),
          retrySignal,
        ) as ConversationHandle['events'],
      };
    }

    if (imageAtts.length === 0) {
      return {
        events: withSpawnRetry(
          () =>
            detectSessionPoison(engine.run(engineInput).events, resumeInUse),
          retrySignal,
        ) as ConversationHandle['events'],
      };
    }
    const { agentId, conversationId } = input;
    async function* withImages() {
      const blocks = await buildPromptBlocks(imageAtts, prompt, agentId, conversationId);
      const handle = engine.run({ ...engineInput, prompt: blocks });
      yield* handle.events;
    }
    return {
      events: withSpawnRetry(
        () => detectSessionPoison(withImages(), resumeInUse),
        retrySignal,
      ) as ConversationHandle['events'],
    };
  }

  async isReady(): Promise<{ ok: boolean; hint: string }> {
    const auth = await detectAuth();
    return { ok: auth.ready, hint: auth.hint };
  }

  async runOneShot(input: OneShotInput, signal?: AbortSignal): Promise<OneShotResult> {
    // 用 engine.run 的非交互模式跑一次性 query
    // 不挂 MCP server / hook，只取 final result text + token 用量
    const abort = new AbortController();
    // {once} + finally removeEventListener 双保险（同 htmlRenderer.withOffscreenPage）：
    // 上游 signal 可能跨多次 runOneShot 复用（如 web_fetch summarizer 透传 ctx.abortSignal），
    // 不清理会累积监听器；signal 已 aborted 时 addEventListener 不回调，需显式联动
    const onAbort = () => abort.abort();
    if (signal?.aborted) abort.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.runOneShotWithAbort(input, abort);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async runOneShotWithAbort(input: OneShotInput, abort: AbortController): Promise<OneShotResult> {
    const append = input.outputSchema
      ? `${input.systemContext ?? ''}\n\n你必须以一段合法 JSON 返回，符合下面这个 schema（不要加 markdown 围栏，不要解释，只输出 JSON）：\n${JSON.stringify(
          input.outputSchema,
          null,
          2,
        )}`
      : input.systemContext;

    // 带图（aside 窗口截图等）→ prompt 升级为多模态块（图在前、文在后，
    // 与 runConversation 的 withImages 路径一致）；无图保持纯字符串，engine 入参零变化
    const prompt: string | EnginePromptBlock[] =
      input.images && input.images.length > 0
        ? [
            ...input.images.map(
              (img): EnginePromptBlock => ({
                type: 'image',
                base64: img.base64,
                // OneShotInput.images 的 mediaType 在 shared 层是 string（调用方保证是合法图片类型），
                // 此处收窄到 EnginePromptBlock 的字面量联合
                mediaType: img.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
              }),
            ),
            { type: 'text', text: input.prompt },
          ]
        : input.prompt;

    // 条款闸误杀重试同 runConversation：open 每次重新 engine.run（重新 spawn）
    const open = () => engine.run({
      prompt,
      cwd: input.cwd ?? process.cwd(),
      abortController: abort,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: append?.trim() ? append : undefined,
      },
      loadSettingSources: false,
      permissionMode: 'bypass',
      // 子进程 env 与 runConversation 同源（构造期注入）——oneShot 的 SDK 子进程同样剥掉 shell 里
      // 劫持用的 ANTHROPIC_BASE_URL / 补鉴权 key（docs/bug/2026-06-09）。
      env: this.env,
      // 摘要 / dream / conversationSummary 等 oneShot 调用不应触发任何工具（D3-a）：
      // builtinTools:[] 结构性关掉全部 SDK 内置工具——这才是「不应触发任何工具」的直接表达。
      // 原先只靠 disallowedTools 黑名单是 fail-open（Read/Edit/Write/Glob 等仍可用，与意图矛盾）。
      // disallowedTools 保留作第二层（其中 WebSearch/WebFetch 是当初真被反向触发过的主目标）。
      builtinTools: [],
      disallowedTools: ['Bash', 'NotebookEdit', 'Task', 'WebSearch', 'WebFetch', 'AskUserQuestion'],
      model: input.model ?? this.defaultModel,
      // oneShot（摘要 / dream）只取终值、无人实时看 → 不开 streaming（engine.run 不传该字段 = 默认关），
      // 不为 partial 增量白付穿子进程边界的成本。思考同 runConversation 三态：默认压掉治慢，显式 false 才放开。
      maxThinkingTokens: input.disableReasoning === false ? undefined : 0,
    }).events;

    let resultText = '';
    let usage: OneShotResult['usage'];
    for await (const ev of withSpawnRetry(open, abort.signal)) {
      if (ev.type === 'result') {
        if (ev.resultText) resultText = ev.resultText;
        usage = ev.usage;
        break;
      }
    }
    return { text: resultText.trim(), usage };
  }

  /**
   * SDK 自带 WebSearch / WebFetch 内置工具——这俩名字的 AgentTool 默认不重复注入，避免冲突。
   *
   * 实例级（非 static）：声明式能力机制经 factory 阶段一调 removeFromIgnoredTools 放行——
   * 联网能力把 web_search/web_fetch 摘出名单，让 oru 工具注入到本实例 + 禁掉 SDK 内置
   * （详见 capabilities/builtins/webSearch.ts）。每个 backend 实例独立一份，互不影响。
   */
  private readonly ignoredToolNames = new Set(['web_search', 'web_fetch']);

  /**
   * 把名字从本实例的 ignored 名单摘除——声明式能力的"先 allow 后 inject"用：
   * factory.injectTools 在同步注入循环**之前**调它，循环走到该工具时 ignored 判断已为 false。
   * 仅清名单，不碰 toolRegistry、不 import factory（避免循环依赖）。
   */
  removeFromIgnoredTools(names: string[]): void {
    for (const n of names) this.ignoredToolNames.delete(n);
  }

  registerTool(tool: AgentTool): void {
    if (this.ignoredToolNames.has(tool.name)) {
      // SDK 自带同语义的内置工具，跳过；不报错，保持 factory 注入流程一致
      return;
    }
    // 外部 MCP 的反射工具（mcp__<serverId>__*）与自有工具一视同仁进 this.tools（2026-07-27）：
    // 桥接后 SDK 再加一层前缀成 mcp__oru__mcp__<serverId>__<tool>，而 normalizeToolName 只剥
    // mcp__oru__，归一结果正是反射注册名——「归一名 == AgentTool 注册名」这条不变量自然成立，
    // 按名字消费的地方（stash / registry 查表 / 折叠策略 / 上屏文案）无需改动。
    this.tools.set(tool.name, tool);
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
  }

  /**
   * 把给定的 AgentTool 打包成一个 MCP server（'oru'）。
   * 每次 runConversation 都重建——闭包持有当前 ToolContext；
   * 入参由调用方从 this.tools 取（白名单回合只传过滤后的子集）。
   */
  private buildToolsMcpServer(agentTools: AgentTool[], ctx: ToolContext): unknown {
    const tools = agentTools.flatMap((t) => {
      // schema 转换逐工具容错：jsonSchemaToZodShape 对非 object 的 root schema 直接抛错，
      // 而外部 MCP 的反射工具带的是第三方 server 的 schema（Oru 管不着它长什么样）。
      // 不接住的话，一个畸形 schema 就让整个回合起不来——坏一个工具不该拖垮整轮对话。
      let shape: ReturnType<typeof jsonSchemaToZodShape>;
      try {
        shape = jsonSchemaToZodShape(t.inputSchema);
      } catch (e) {
        console.warn(
          `[mcp] 工具 ${t.name} 的 inputSchema 无法转换成 zod，本回合不挂它：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return [];
      }
      return engine.mcp.defineTool(
        t.name,
        t.description,
        shape,
        async (input: unknown) => {
          try {
            const result = await executeAgentTool(t, input, ctx);
            // structured 不流经 MCP content（下方只包 text+images）——在这个唯一咽喉搭桥送去
            // stream.ts（takeToolStructured 兜底取），任何返回 structured 的工具自动被覆盖，
            // 不要求各工具自行 stash（散点必漏：list_scheduled_tasks 曾漏过）。
            if (result.structured) {
              stashToolStructured(ctx.conversationId, t.name, input, result.structured);
            }
            // 文字始终在前；带 images 的工具（render_html 截图）把每张图追加成 MCP image content，
            // SDK 会把它包成 tool_result 的 image block 喂回模型，让模型"看见"（决策 2）。
            const content: Array<
              | { type: 'text'; text: string }
              | { type: 'image'; data: string; mimeType: string }
            > = [{ type: 'text', text: result.text }];
            for (const img of result.images ?? []) {
              content.push({ type: 'image', data: img.base64, mimeType: img.mediaType });
            }
            return { content, isError: result.isError ?? false };
          } catch (e) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `${t.name} 抛错：${e instanceof Error ? e.message : String(e)}`,
                },
              ],
              isError: true,
            };
          }
        },
      );
    });
    return engine.mcp.createServer({ name: 'oru', version: '0.2.0', tools });
  }
}

/**
 * 判断当前 conversation 的 sdkSessionId 是否相对于 history 过期。
 * 过期的标志：history 里最近一条 assistant 消息不是由 claude-code backend 写的——
 * 说明中间几轮在别的 backend 跑过，SDK 看不到那些内容，必须重新灌历史。
 *
 * 没有 assistant 消息（全新对话或只有 user）→ 不算过期，让正常路径处理。
 */
function isSessionStale(history: ReadonlyArray<ChatMessage> | undefined): boolean {
  if (!history || history.length === 0) return false;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role !== 'assistant') continue;
    const bt = history[i].backendType ?? 'claude-code';
    return bt !== 'claude-code';
  }
  return false;
}

/**
 * 把 ChatMessage[] 渲染成首条 prompt——给 ClaudeCode backend 在没有 sdkSessionId 但有历史时用。
 *
 * 策略：
 * - 折叠所有 assistant 消息成纯文本（forceCollapse=true），不让 SDK 看到祖传 tool_use blocks
 * - 把历史里最后一条 user 消息从历史段切走，单独贴在尾部当"当前消息"
 * - 用清晰的中文分隔（"【用户】" / "【你】" / "---"）让 SDK 模型理解角色
 *
 * 用 markdown 风格而非"假装是 messages 数组"——SDK 的 prompt 字段就是字符串。
 */
/** 取 history 末尾的 user 消息文本（续跑无新 userMessage 时用它作当前消息）。 */
function lastUserText(history: ConversationInput['history']): string | undefined {
  if (!history) return undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') return history[i].text ?? '';
  }
  return undefined;
}

function renderSeedPrompt(
  history: ReadonlyArray<ChatMessage>,
  userMessage: string,
  /** 附件落盘目录按 agent 分——把老图的占位句改写成可读回的绝对路径要用它 */
  agentId: string,
  onInferenceView?: ConversationInput['onInferenceView'],
  /** 已随本轮 prompt 一并附上的图（relPath 集合）——占位句改口为「已附上」，见下 */
  carriedImageRelPaths?: ReadonlySet<string>,
): string {
  // 找出历史里最后一条 user 消息：那就是当前用户消息的来源，单独放尾部
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const past = lastUserIdx >= 0 ? history.slice(0, lastUserIdx) : Array.from(history);
  // 灌历史是纯文本，附件默认渲染成「当前模型不支持视觉」占位句。两种情形这句话都是错的，
  // 借 historyAdapter 既有的 fallbackText 兜底位分别改口（浅拷贝，不动原历史）：
  //   ① 已并入本轮 prompt 的种子图：图明明在模型眼前，文本却否认，模型会顺着文本拒绝认图
  //      （真机 smoke 实测：模型看得见图，仍答"我看不见截图"）。
  //   ② 其余历史图：图还在磁盘上，改成指路。锚点就落在原文那一行，多图与原文的位置对应
  //      关系天然保留，模型不看就不花 token——切 backend 后"这两张截图我看不到内容"的那类
  //      降级由此消掉（真实会话 cnv_TymI7oJum2）。不盲目全量重发图，正是为了不喂一堆无锚定的图。
  const annotated = past.map((m) => {
    if (!m.attachments?.some((a) => a.kind === 'image')) return m;
    return {
      ...m,
      attachments: m.attachments.map((a) => {
        if (a.kind !== 'image') return a;
        if (carriedImageRelPaths?.has(a.relPath)) {
          return { ...a, fallbackText: '截图已随本条消息一并附上——见前面的附图，多张时按出现顺序对应' };
        }
        try {
          return { ...a, fallbackText: `原图还在 ${attachmentAbsPath(agentId, a)}，要看内容就用 read_file 读它` };
        } catch {
          return a; // relPath 异常（空串等）——退回默认占位，不为一张图炸整轮
        }
      }),
    };
  });
  const inferenceViewEnabled = isInferenceViewEnabled();
  const { messages: normalized, savings } = adaptHistory({
    messages: annotated,
    targetProtocol: 'sdk-mcp',
    forceCollapse: true,
  });
  onInferenceView?.({
    enabled: inferenceViewEnabled,
    adapterRan: true,
    savings,
    wireHistory: normalized,
  });

  const lines: string[] = [];
  if (normalized.length > 0) {
    lines.push('以下是这次对话之前的历史回顾——把它当作我们已经讲过的内容继续推进：');
    lines.push('');
    for (const m of normalized) {
      const text = extractText(m);
      if (!text.trim()) continue;
      lines.push(m.role === 'user' ? '【用户】' : '【你】');
      lines.push(text);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('现在用户刚发了下面这条消息，请回应它：');
    lines.push('');
  }
  lines.push(userMessage);
  return lines.join('\n');
}

function extractText(m: NormalizedMessage): string {
  return m.blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * 取"本轮新上传"的图片附件——仅当本轮真有新用户消息时，返回 history 末条 user 消息的 image 附件。
 * 续跑（审批后自发起回合，userMessage 为 undefined）一律返回空，避免把上一轮的旧图重发一遍。
 * 直接收 userMessage 而非布尔：`''` 是「有一条空文本的新消息」（纯图消息），必须与续跑区分——
 * 曾因调用点 `!!userMessage` 真值判断把纯图消息误判续跑、当轮图静默丢弃。
 */
export function currentTurnImageAttachments(
  history: ReadonlyArray<ChatMessage> | undefined,
  userMessage: string | undefined,
): ChatAttachment[] {
  if (userMessage === undefined || !history) return [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') {
      return (history[i].attachments ?? []).filter((a) => a.kind === 'image');
    }
  }
  return [];
}

/**
 * fresh-run 灌历史时随种子并入的图——取历史中点睛指代卡（kind 'aside-referent'）的图片附件。
 *
 * 为什么存在：aside 对话出生即带指代卡，截图挂在这张历史消息上、永远不是「本轮最后一条
 * user 消息」——currentTurnImageAttachments 的口径碰不到它，而灌历史（renderSeedPrompt）
 * 又是纯文本，不补这一手截图就整条丢：模型顺着指代文字硬聊，被追问才承认看不见图。
 * 灌历史那一轮是截图进 session 的唯一机会：进过一次，后续 resume 由 SDK session 自然续传。
 *
 * 口径刻意收窄到 aside-referent、不扩大到历史里所有 user 消息的图：普通对话切 backend
 * 重灌时历史已拍扁成纯文本，多图与原文的对应关系丢失，盲目全量重发只会喂一堆无锚定的图
 * （切 backend 丢图维持既有降级，另案）。
 *
 * 末条 user 消息若本身就是指代卡（addReferent 作首轮），其图归 currentTurnImageAttachments
 * 管——这里跳过它，两条通路各取各的，合并后不重不漏。
 */
export function seedReferentImageAttachments(
  history: ReadonlyArray<ChatMessage>,
  userMessage: string | undefined, // 语义同 currentTurnImageAttachments：undefined=续跑，'' 也是新消息
): ChatAttachment[] {
  const hasNewUserMessage = userMessage !== undefined;
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const out: ChatAttachment[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const m = history[i];
    if (m.role !== 'user' || m.kind !== 'aside-referent') continue;
    // 当轮消息（仅当本轮真有新用户消息时存在）归 currentTurnImageAttachments
    if (hasNewUserMessage && i === lastUserIdx) continue;
    out.push(...(m.attachments ?? []).filter((a) => a.kind === 'image'));
  }
  return out;
}

/**
 * 把图片附件读成 base64 的 EnginePromptBlock。单张 load 失败转占位文字
 * （与 historyAdapter / Anthropic 直连一致），不让一张坏图崩掉整轮。
 */
async function loadImageBlocks(
  atts: ChatAttachment[],
  agentId: string,
  conversationId: string,
): Promise<EnginePromptBlock[]> {
  const out: EnginePromptBlock[] = [];
  for (const a of atts) {
    try {
      const base64 = await readAttachmentBase64(agentId, conversationId, a);
      out.push({ type: 'image', base64, mediaType: a.mediaType });
    } catch {
      // 与 Anthropic 直连同口径：load 失败只标"加载失败"，不混用 fallbackText
      // （fallbackText 是"模型不支持视觉"时的主动降级文案，与"读盘失败"语义不同）
      out.push({ type: 'text', text: `[图片加载失败：${a.filename}]` });
    }
  }
  return out;
}

/**
 * imageAtts（前）+ 文本（后）→ 多模态 prompt 块——图块 load 失败转占位文字（loadImageBlocks 内处理）；
 * 无图则单文本块。steering 活流路径与 withImages 单发路径共用，避免两路各拼一遍（系统性一致）。
 *
 * 空文本不追加块（口径同 historyAdapter 的 `text.trim().length > 0`）：纯图消息 promptText 为 ''，
 * 若照样产出 `text:''` 块，CLI 自动给近端 user 消息文本块打 cache_control，Anthropic API 拒绝
 * 空文本块带缓存标记 → 400 中断整轮。导出仅为单测。
 */
export async function buildPromptBlocks(
  imageAtts: ChatAttachment[],
  promptText: string,
  agentId: string,
  conversationId: string,
): Promise<EnginePromptBlock[]> {
  const blocks: EnginePromptBlock[] = [];
  if (imageAtts.length > 0) {
    blocks.push(...(await loadImageBlocks(imageAtts, agentId, conversationId)));
  }
  if (promptText.trim()) blocks.push({ type: 'text', text: promptText });
  return blocks;
}

/**
 * Steering 活流回合（claude-code 近似中途转向）——interrupt 驱动续喂的状态机。
 *
 * 持续活流（engine live 模式）跑 SDK query，监听工具边界：此刻队列有待读入的「将生效」就 interrupt
 * 截断当前轮；截断产出的 result 边界落盘消费 + appendInput 续喂，逼近「干完手头这一个工具就读入转向」。
 * 不含 steering 时（hasPendingSteering 恒 false）行为退化为「整轮跑完一个 result 即结束」，与单发等价。
 *
 * 单状态机 `phase`（C1：SDK result 不带 is_interrupt 标志，只能靠本侧状态位判定）：
 * - 'running'：正常跑，只有这个状态才在工具边界考虑 interrupt。
 * - 'awaiting-interrupt'：已发 interrupt，等它产出的 result 边界来续喂；其间不再发下一次 interrupt
 *   （M3 多轮 steering 串行翻转的守卫）。result 是「我为 steering 触发的 interrupt 产出的」即由此态判定。
 *
 * M2（撞 pending 审批不打断）天然成立：interrupt 只在观察到 `tool_result` 事件的边界触发，而挂着的审批卡
 * 对应的工具尚未产出 tool_result（阻塞在 execute 内等用户），故不会进 interrupt 分支——自动推迟到审批
 * resolve、该工具回出 tool_result 的下一个边界。无需额外代码。
 *
 * 详尽论证见 docs/tech/2026-06-15-busy-message-queue-tech-design.md §5 与 spike-findings（v5）。
 */
async function* runSteerableConversation(
  engineInput: EngineRunInput,
  input: ConversationInput,
  promptText: string,
  imageAtts: ChatAttachment[],
): AsyncGenerator<EngineEvent> {
  const firstBlocks = await buildPromptBlocks(
    imageAtts,
    promptText,
    input.agentId,
    input.conversationId,
  );
  const handle = engine.run({ ...engineInput, live: true, prompt: firstBlocks });
  let phase: 'running' | 'awaiting-interrupt' = 'running';

  for await (const ev of handle.events) {
    if (ev.type === 'result') {
      if (phase === 'awaiting-interrupt') {
        phase = 'running';
        // 截断产出的 result 边界：drainSteering 落盘=消费（先于投递），再 appendInput 续喂转向。
        // 同边界一并带出后台终态系统记（drainBoundaryNotice，纯文本块，不套用户补话前缀）。
        const texts = input.drainSteering ? await input.drainSteering() : [];
        const notices = input.drainBoundaryNotice ? await input.drainBoundaryNotice() : [];
        const blocks: EnginePromptBlock[] = [];
        if (texts.length > 0) {
          blocks.push({ type: 'text', text: `${STEERING_SUPPLEMENT_PREFIX}\n${texts.join('\n\n')}` });
        }
        for (const n of notices) blocks.push({ type: 'text', text: n });
        if (blocks.length > 0) {
          handle.appendInput?.(blocks);
          continue; // 吞掉 error_during_execution result，等续喂后的新轮
        }
        // 空 drain（peek 到 pull 之间被撤回、且无后台终态）：无可续喂——本轮已被截断，干净收尾。
        // 这个 result 是 interrupt 产出的 error_during_execution，但对用户不算真错误（撤回的不在历史、
        // 模型 partial 工作已进 session、不二次执行——原则 4 兜底），故 isError 改 false、不报错。
        yield { type: 'result', resultText: ev.resultText, isError: false };
        return;
      }
      // 真回合结束
      yield ev;
      return;
    }

    // 非 result 事件原样透传（session / assistant_text / tool_use / tool_result / retrying / llm_usage）
    yield ev;

    // 工具边界：仅在正常跑时考虑 interrupt（M2 见函数注释，天然推迟过审批）。
    if (ev.type === 'tool_result' && phase === 'running' && input.hasPendingSteering?.()) {
      phase = 'awaiting-interrupt';
      await handle.interrupt?.();
    }
  }
}

// re-export 给单元测试方便
export { z };
export { renderSeedPrompt, runSteerableConversation };
