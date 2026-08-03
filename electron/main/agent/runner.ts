import type { ServerEventPayload } from '@shared/protocol';
import type { SkillEventPayload } from '@shared/agent/backend';
import type {
  Agent,
  BackendType,
  ChatMessage,
  Conversation,
  LlmUsage,
  MemoryRecordPayload,
  ToolCall,
  ToolProtocol,
} from '@shared/types';
import { rebuildActivatedPlugins } from '../plugins/activatedState';
import { ErrorCodes } from '@shared/types';
import { pipeSdkToEvents } from './stream';
import { attachInterruptedTurn, type PartialTurn } from './interrupted';
import { makeInflightWriter } from './turnInflight';
import { buildRuntimeContext } from './hooks';
import { loadMcpPromptIfEnabled } from './mcpPrompt';
import { buildStableSystemContext } from './stableSystemContext';
import { MEMORY_B_PATH_INSTRUCTION } from '../prompts/memoryBPath';
import { provisionAgent } from './capabilities';
import type { ProposalEmit } from './oruMcpFactory';
import type { InheritedToolContext, ToolContext } from '@shared/agent/backend';
import { getBackendFor, resolveThinkingDisable } from './backends';
import { ensureCurrentTurnInHistory } from './backends/historyContract';
import { isContextOverflowError } from './backends/overflow';
import { SessionPoisonError } from './backends/sessionPoison';
import { buildSnapshot } from '../memory/snapshot';
import { buildRecallInjection } from '../memory/recall/inject';
import { buildSelfKnowledgeInjection } from '../selfKnowledge/inject';
import { getActiveProjectId } from './activeProject';
import { readHistoryForLLM, updateFoldedBeforeMessageId } from '../conversations/store';
import { applyFoldingByWatermark } from './context/applyTier1Folding';
import { organizeContext } from './context/organize';
import { invalidatePriorReads } from './conversationFileState';
import { estimateTokens } from './context/tokenEstimate';
import { getSettings } from '../projects/store';
import { debugLogger } from '../debug/logger';
import { teeAndDerive } from '../debug/teeAndDerive';
import { runSubagent } from './subagentChat/runner';
import { resolveFocusDeckPath } from '../deck/submissions';
import { resetBreaker } from './circuitBreaker';
import { acquire as keepAwakeAcquire, release as keepAwakeRelease } from '../keepAwake';

type Emit = (ev: ServerEventPayload) => void;

export type RunArgs = {
  agent: Agent;
  conversation: Conversation;
  messageId: string;
  /** 用户输入文本；续跑（审批后自动接着干）时为 undefined——无新消息，从 history 末尾续 */
  userText?: string;
  emit: Emit;
  /** 当引擎给出新的 session_id 时回调（首次或 compact 后）；null=作废编号（G112/G54 弃号重灌） */
  onSdkSessionId: (sid: string | null) => Promise<void>;
  /**
   * 分身递交提案时的回调。**可选且不得塞 noop 兜底**：装卸 / 写类工具据它是否挂着判断
   * 「这条回合有没有人能弹卡、有人能点」——挂一个什么都不做的 noop 会让它们进同步等待，
   * 等一个永不到来的决定（评论回合就是这样整轮挂死的）。不挂 = 工具走无 UI 分支、不执行、
   * 如实回执。
   */
  onProposal?: ProposalEmit;
  /** 装卸类免审批执行完的「留痕卡」回调（见 InheritedToolContext.onProposalTrace）。 */
  onProposalTrace?: ToolContext['onProposalTrace'];
  /** 装卸类执行完成后的 chip 回调（见 InheritedToolContext.onProposalOutcome）。 */
  onProposalOutcome?: ToolContext['onProposalOutcome'];
  /**
   * 主对话用：ask_user_choice 工具弹「带选项提问」卡片并阻塞等回答的回调（可选）。
   * 只挂主对话——不传给对话期 subagent（PRD：本期只主对话），subagent 调该工具优雅 isError。
   */
  askUserChoice?: ToolContext['askUserChoice'];
  /**
   * 断路器跳闸卡广播回调（G01/G04）——工具调用失控时 executeAgentTool 经它弹「继续放行 / 停止」卡。
   * 只挂主对话（有 UI 能弹卡）；不挂 = 断路器不阻塞、放行。
   */
  onCircuitBreak?: ToolContext['onCircuitBreak'];
  /**
   * Steering：动作边界 drain 回调，透传给 backend.runConversation 的同名字段。
   * 主对话起回合时由 router 注入（绑定本 conv 队列 + persistConsumed）；不挂 = 无 steering。
   * 语义见 shared/agent/backend.ts ConversationInput.drainSteering。
   */
  drainSteering?: () => Promise<string[]>;
  /**
   * Steering 待读入探测（非消费）：claude-code 据此决定是否在工具边界 interrupt 截断转向。
   * 与 drainSteering 同由 router 主对话起回合时注入；语义见 ConversationInput.hasPendingSteering。
   */
  hasPendingSteering?: () => boolean;
  /**
   * 边界系统通知 drain（后台终态）：动作边界随 steering 一并带出未播报的后台任务终态。
   * 由 router 主对话起回合时注入（绑 buildUnannouncedTaskHint）；语义见 ConversationInput.drainBoundaryNotice。
   */
  drainBoundaryNotice?: () => Promise<string[]>;
  /** Twin 通过 record_memory 写新记忆时的回调（可选） */
  onMemoryRecord?: (payload: MemoryRecordPayload) => Promise<void>;
  /** 当天首次要改某个非 git 项目时的回调（可选）——让上层在对话流落提示条 */
  onGitHint?: () => Promise<void>;
  /** AI 收尾提交组后的回调（可选）——让上层广播组状态变化到前端 */
  onArtifactSubmissionChanged?: (artifactId: string) => Promise<void>;
  /**
   * 触发上下文压缩时的回调；router 接住后落盘 + 广播 chat.contextCompressed 事件
   * 不挂表示"不响应压缩通知"——本路径仍能跑（压缩只影响发给 LLM 那份），但用户看不到通知
   */
  onContextCompressed?: (msg: ChatMessage) => Promise<void>;
  /**
   * Skill 模块 v1：activate_plugin / read_skill 等工具调用时回调，
   * router 接住后写 plugin-activate / skill-call chip 到对话流 + broadcast。
   */
  onSkillEvent?: (payload: SkillEventPayload) => Promise<void>;
  /**
   * 对话期 Subagent（v2）：runner 调 Task 工具时所需的主对话流写入 hook。
   * 不挂 → Task 工具不可用（ctx.runSubagent 不挂）。
   * 见 electron/main/agent/subagentChat/runner.ts。
   */
  subagentSupport?: {
    /** 实时广播 subagent chip 状态变化（不落盘；spinner / awaiting_approval 等切换） */
    broadcastChip: (chip: ChatMessage) => void;
    /** 完成时落盘 chip 到主对话 jsonl + 广播（最终态快照） */
    persistChip: (chip: ChatMessage) => Promise<void>;
  };
  // ─── 评论场景字段（PR-D2）───
  /** 透传到 ToolContext.boardCurrentTaskId；delete_task 工具据此守卫"不能在自身评论里删自己" */
  boardCurrentTaskId?: string;
  /**
   * 覆盖 active project：
   *   - undefined：用 getActiveProjectId()（默认主聊天行为）
   *   - null：显式"无项目"模式（评论场景 task.projectTag 不命中任何项目）
   *   - string：强制走该 projectId（评论场景命中具体项目）
   */
  projectIdOverride?: string | null;
  /** 拼到 stableSystemContext 末尾的额外稳定段（评论行为规则） */
  extraStableSystemPrompt?: string;
  /**
   * 随手评点（aside）短聊回合：true 时 system prompt 同步裁剪——
   * stableSystemContext 走裸模式（只拼人格 + extraStableSystemPrompt），
   * 且不注入 provisionAgent 的 capabilityPrompt。一个开关带动两处，
   * aside 管线接线时只置这一个字段。记忆快照走 dynamic 段，不受影响。
   * 开关不开（undefined / false）时现行为零变化。
   * 详见 docs/tech/2026-06-10-option-click-meta-comment-tech-design.md 的 systemContext 裁剪段。
   */
  asideMode?: boolean;
  /** 拼到 dynamic 段的额外片段（task 字段快照） */
  extraDynamicSystemPrompt?: string;
  /** 从工具集中排除的工具名（透传到 backend；评论场景用来 deny Task / commit_changes） */
  extraToolDenylist?: string[];
  /**
   * 本回合的工具白名单（aside 只读短聊）——原样透传 ConversationInput.restrictToolsTo，
   * 三 backend 在工具列表层面收口（undefined = 不收口；[] = fail-closed 零工具，
   * 语义见 shared/agent/backend.ts）。与 extraToolDenylist 并存时取交集。
   */
  restrictToolsTo?: readonly string[];
  // ─── debug 模块字段（PR-A）───────────────
  /** 触发来源；debugLogger 用来填 round_start.source（PRD 第四节"用户输入详情"里的"来源"字段） */
  source?: import('@shared/debug/types').RoundSource;
  /** 用户附带的图片/文件元数据；debugLogger 用来填 round_start.attachments */
  attachments?: import('@shared/debug/types').DebugAttachment[];
};

export type RunChatResult = {
  resultText: string;
  isError: boolean;
  /** 本轮流式过程中累积的所有 ToolCall（含 result）；router 落盘时填到 ChatMessage.toolCalls */
  toolCalls: ToolCall[];
  /** 本回合流过 reasoning（思考通道）delta——空产出报错文案据此区分「思考了但没给出回答」 */
  sawReasoning: boolean;
  /** 本次对话使用的 backend / tool 协议——router 据此给落盘 ChatMessage 打标 */
  backendType: BackendType;
  toolProtocol: ToolProtocol;
  /** 本次使用的 RegisteredModel.id（debug 溯源用）；OAuth fallback 走 SDK 默认时为 undefined */
  modelId?: string;
  /** 本次使用的 BackendProvider.id（debug 溯源用）；OAuth fallback 时为 undefined */
  providerId?: string;
};

/**
 * 撞墙重试上限——绝大多数对话不会用满；超出后视作"丢光也装不下"，
 * 抛回原 overflow 错（属于 PRD 第三档兜底，工具上下文限制 PRD 处理根因）。
 */
const MAX_OVERFLOW_RETRIES = 10;

/**
 * 撞墙时丢老消息的算法：丢最老的 n "轮"（user → assistant 配对），保留本轮 user。
 * - 不修改入参数组，返回新数组
 * - 一"轮"的锚点是 user 消息；夹在两条 user 之间的 assistant / system / memory-record 都跟着丢
 * - 永远保留最后一条 user（本轮，不能丢）
 *
 * 例：history = [user1, asst1, system_terminator, user2, asst2, user3]
 *   dropOldestTurns(_, 1) → [user2, asst2, user3]
 *   dropOldestTurns(_, 2) → [user3]
 *   dropOldestTurns(_, 3) → [user3]（保留本轮兜底）
 */
export function dropOldestTurns(history: ChatMessage[], n: number): ChatMessage[] {
  if (n <= 0) return history;
  const userIdxs: number[] = [];
  for (let i = 0; i < history.length; i += 1) {
    if (history[i].role === 'user') userIdxs.push(i);
  }
  if (userIdxs.length === 0) return history;
  // 至少保留最后一条 user 消息
  if (n >= userIdxs.length) {
    return history.slice(userIdxs[userIdxs.length - 1]);
  }
  return history.slice(userIdxs[n]);
}

const activeAbortControllers = new Map<string, AbortController>();

/**
 * 唤醒对账用的「在途半截」内存镜像（文档 sleep-wake-chat-recovery）：由 runChatLocked 回合内
 * 每次 partial 更新时写、最后一句仍在本轮（onPartialUpdate）后保持；回合收尾（成功/中断落盘）
 * 后清。整机睡眠进程内存原地保留，唤醒时从这里取「流到一半、未落盘」的完整半截——优先于
 * turnInflight 草稿（草稿是 500ms 节流镜像，会缺最后几行）。
 *
 * 只在有产出时留档；空 partial 不写，避免把「还没开口的回合」误呈为半截。
 */
const activePartials = new Map<string, { messageId: string; partial: PartialTurn }>();

function activeKey(agentId: string, conversationId: string): string {
  return `${agentId}:${conversationId}`;
}

/**
 * 供唤醒对账 query handler 读某对话在途半截（runner 内存中仍在流的那个）。
 * 找不到 / 空 → null。返回副本 + 回合 messageId（供前端把半截接到对应消息），避免调用方改动污染内存值。
 */
export function readActivePartial(
  agentId: string,
  conversationId: string,
): { messageId: string; partial: PartialTurn } | null {
  const k = activeKey(agentId, conversationId);
  const entry = activePartials.get(k);
  if (!entry) return null;
  if (entry.partial.resultText.length === 0 && entry.partial.toolCalls.length === 0) return null;
  return {
    messageId: entry.messageId,
    partial: { resultText: entry.partial.resultText, toolCalls: [...entry.partial.toolCalls] },
  };
}

/**
 * 回合正式落盘（成功 / 优雅中断）后清掉镜像——与 clearTurnInflight 同处调用。半截已进历史，
 * 不再需要留档；清掉避免跨界残留把别轮在途误呈为半截。
 */
export function clearActivePartial(agentId: string, conversationId: string): void {
  activePartials.delete(activeKey(agentId, conversationId));
}

export function abortConversation(agentId: string, conversationId: string): boolean {
  const k = activeKey(agentId, conversationId);
  const ac = activeAbortControllers.get(k);
  if (!ac) return false;
  ac.abort();
  activeAbortControllers.delete(k);
  return true;
}

export function isConversationBusy(agentId: string, conversationId: string): boolean {
  return activeAbortControllers.has(activeKey(agentId, conversationId));
}

export async function runChat(args: RunArgs): Promise<RunChatResult> {
  const k = activeKey(args.agent.id, args.conversation.id);
  if (activeAbortControllers.has(k)) {
    const err = new Error(`conversation ${args.conversation.id} is already busy`) as Error & {
      code?: string;
    };
    err.code = ErrorCodes.AGENT_BUSY;
    throw err;
  }
  // 占位与检查必须在同一同步段完成（中间零 await）——否则并发的第二次 runChat
  //（如「审批后自动续跑」撞上用户 chat.send）会在让出 event loop 的间隙穿过检查：
  // 同一对话两轮并发写历史，且后来者覆盖 AbortController、Esc 只能停后者。
  //（仓库约定「await 后重检共享状态」的落实——这里干脆消掉 check 与 set 之间的 await。）
  const abortController = new AbortController();
  activeAbortControllers.set(k, abortController);
  keepAwakeAcquire();
  try {
    return await runChatLocked(args, abortController);
  } finally {
    // 占位提前后，真正起跑之前的任何失败（backend 不可用 / 密钥解析抛错 / prompt 拼装
    // 失败）都从这里释放——否则对话被永久卡成忙。
    // 只删自己的占位：abortConversation 已提前 delete，若此间新一轮已占位，
    // 这里无条件 delete 会误删新轮（await 后重检共享状态）。
    if (activeAbortControllers.get(k) === abortController) {
      activeAbortControllers.delete(k);
      keepAwakeRelease();
      // 断路器回合收尾清零（G01/G04）：连续失败计数不跨回合泄漏（否则上一轮攒的失败带进
      // 下一轮、让下一轮更早误跳闸），并释放本对话的断路器状态。只在仍是本轮时清——
      // 新一轮已占位则归它所有（await 后重检共享状态）。
      resetBreaker(args.conversation.id);
    }
  }
}

/** runChat 的真正执行体——调用方（仅 runChat）已完成忙锁占位，本函数返回/抛出后由其释放 */
async function runChatLocked(
  args: RunArgs,
  abortController: AbortController,
): Promise<RunChatResult> {
  // 回合开始时刻——先于回合起点压缩落卡捕获，崩溃恢复草稿的 startedAt 用它
  // （不变量：回合消息 createdAt 一律盖回合开始，见 runChatAndPersist / makeInflightWriter）
  const turnStartedAt = Date.now();
  const {
    agent,
    conversation,
    messageId,
    userText,
    emit,
    onSdkSessionId,
    onProposal,
    onProposalTrace,
    onProposalOutcome,
    askUserChoice,
    onCircuitBreak,
    onMemoryRecord,
    onGitHint,
    onArtifactSubmissionChanged,
    onContextCompressed,
    onSkillEvent,
  } = args;

  // ─── debug 插桩开始 —— enabled=false 时返回 NoOp，主路径几乎零开销 ──
  const round = debugLogger.beginRound({
    roundId: messageId,
    conversationId: conversation.id,
    ownerId: agent.ownerId,
    agentId: agent.id,
    agentName: agent.name,
    source: args.source ?? 'main_chat',
    userText: userText ?? '',
    attachments: args.attachments,
  });

  // 评点模型（二期 §3）：aside 短聊按 asideComment 用途取 backend——短评与短聊是同一个
  // 「轻 Oru」，浮层里前后两句必须是同一个脑子。转正（rekind→sub）后自然回 twinMain。
  const backend = await getBackendFor(args.asideMode ? 'asideComment' : 'twinMain');
  // 后端可用检查（G28）：chat.send 起回合入口已在落盘前预检本对话（失败零代价，走 checkBackendReady）；
  // 这里是其余起回合入口（渠道入站 / 定时执行 / 续跑）的兜底——直接用已构造的 backend 实例探，
  // 同 isReady 口径。仍失败则抛 AGENT_NO_AUTH，由上层落红条 + 保留重连入口。
  const ready = await backend.isReady();
  if (!ready.ok) {
    const err = new Error(ready.hint) as Error & { code?: string };
    err.code = ErrorCodes.AGENT_NO_AUTH;
    throw err;
  }

  // 读 history 给 backend：所有 backend 都消费——ClaudeCode 在没有 sdkSessionId 时灌历史成首条 prompt，
  // 其他 backend 整段重发；chat.send 路径末尾已含本轮 user 消息（router 先 appendMessage），
  // 非用户发起路径（[重试]/loop/审批续跑/播报等）由下方 ensureCurrentTurnInHistory 补齐临时
  // user 轮（HTTP 后端不读 userMessage，当前轮输入必须在 history 末尾；claude-code 原样透传）。
  // 补齐放在读出即做：token 估算、compress、organize 和最终 payload 看同一视图，且「整理保留
  // 末尾 user 轮」的既有不变量恰好保护它。临时轮不落盘，下轮重读持久 history 自然消失。
  //
  // 用 readHistoryForLLM——从最后一个 'context-compressed' marker 之后切，
  // 让 token 估算、compressIfNeeded 和最终 LLM payload 看到的是同一个"有效视野"，
  // 避免 marker 之前那些"已摘要/丢弃"的消息以全量身份再次进入推理上下文。
  //
  // Tier 1 折叠（view transformation）：按持久水印折叠——水印之前的工具结果替换为短桩，
  // 廉价、无 LLM 调用。水印只在整理时刻由 organizeContext 前移（S16 G63），两次整理之间固定，
  // 折叠前缀逐字节稳定、不每轮碎 prompt cache；细节见 applyTier1Folding.ts。
  const rawHistory = await readHistoryForLLM(agent.id, conversation.id);
  const history = ensureCurrentTurnInHistory(
    applyFoldingByWatermark(rawHistory, conversation.foldedBeforeMessageId),
    userText,
    backend.backendType,
    conversation.id,
  );

  // 思考三态（Track B）：按本回合 usage（aside→asideComment、否则 twinMain）走中央判据——
  // 干活/对话类默认开思考、asideComment 默认关；模型不支持思考回落 undefined（后端缺省压掉）。
  const turnUsage: LlmUsage = args.asideMode ? 'asideComment' : 'twinMain';
  const disableReasoning = resolveThinkingDisable(turnUsage, await getSettings());

  const promptBuildStartTs = Date.now();

  // 拼装顺序分稳定层 + 动态层：
  //   [稳定层] = agent 人设 + B 路径记忆规则                       ← 永不变（同 agent 生命周期内），命中 cache
  //   [动态层] = 记忆快照 + [运行时上下文]                          ← 每轮现拼，命不中 cache
  //              其中 [运行时上下文] = 当前时间 + 项目环境 + 未播报任务
  // user message 不再加任何前缀——所有元数据从 system 注入，模型权威性更强
  // ⚠ 段顺序按"稳定性递减"排列（stable → 能力 → 快照 → 运行时），故可在任意稳定点切 cache：
  //   两层缓存在 stable 末尾与"快照"末尾各切一刀（见下 sessionStableSystemContext）。
  //   动这个顺序前先想清楚会不会把"会话级稳定段"打散、破坏缓存切分。
  //
  // PR-D2 评论场景：args.projectIdOverride 三态语义见 RunArgs 注释；
  //   评论场景按 task.projectTag 解析得到 projectIdOverride，使 hooks/buildSnapshot/CLAUDE.md
  //   都按该项目走，不污染主聊天单例 getActiveProjectId()。
  const effectiveProjectId =
    args.projectIdOverride !== undefined ? args.projectIdOverride : (getActiveProjectId() ?? null);
  const memorySnapshot = await buildSnapshot(agent.ownerId, effectiveProjectId);
  const runtimeContext = await buildRuntimeContext(conversation.id, {
    ownerId: agent.ownerId, // 计划清单按对话落盘，取盘要三段路径
    agentId: agent.id,
    projectId: effectiveProjectId,
    history, // S18：扫描历史尾部注入「定时任务后台执行完毕」旁白
    asideMode: args.asideMode, // aside 白名单没有 MCP 工具，跳过不可达点名
  });
  const mcpPrompt = await loadMcpPromptIfEnabled();

  const stableSystemContext = await buildStableSystemContext({
    agentSystemPromptAppend: agent.systemPromptAppend,
    memoryBPathInstruction: MEMORY_B_PATH_INSTRUCTION,
    mcpPrompt,
    // 项目 CLAUDE.md 已迁 project-claude-md 能力：经下方 provisionAgent 的
    // effectiveProjectId 注入第二层，切项目不再击穿第一层
    extraStableSystemPrompt: args.extraStableSystemPrompt,
    bare: args.asideMode,
  });
  // 声明式能力 · 阶段二：联网引导 prompt + 预算桶 reset（主对话用 conversation.id 桶，子 agent 另有独立桶）+
  // SDK 内置 WebSearch/WebFetch 禁用。capabilityPrompt 是稳定内容，叠在 stable 段之后、dynamic 之前；
  // 但不并入 stableSystemContext（cache marker / subagent parentStable 保持纯净，子 agent 自己再 provision）。
  const provision = await provisionAgent({
    usage: 'twinMain',
    searchBudgetId: conversation.id,
    activeProjectId: effectiveProjectId,
  });
  // 眼睛供给（任务 9 决策 3 / §5）：进 while 重试循环【之前】一次性解析"当前焦点提交组"的 deckPath，
  // 注入 toolContext，让 view_slide / render_contact_sheet 锚到当前焦点 deck。无活跃组 → undefined、
  // 不设字段，工具调用时优雅 isError（沿用任务 6）。对象字面量里不能 await、循环里也不该每轮重算。
  const deckPath = await resolveFocusDeckPath(conversation.id);

  // aside 短聊不注入 capabilityPrompt（与 stableSystemContext 裸模式同一开关）——能力 prompt
  // 教的全是白名单外工具的用法；provision 的 toolContextPatch / extraDisallowed 照常生效。
  const capabilityPrompt = args.asideMode ? '' : provision.capabilityPrompt;
  // 记忆召回（PRD §5）：每轮串联跑廉价挑选器召回相关往事，打「过去的背景、非当前指令」围栏。
  // 放 dynamicPart 里 memorySnapshot 之后——落在 sessionStable 缓存断点（=stable+能力+快照）之后，
  // 不破坏两个缓存断点；带超时、超时/故障优雅降级（本轮不带往事、不卡回复）。aside 短评不召回。
  // 自我认知按相关性注入（子系统 C，S35·G05）：每轮读能力候选简介 + 对话窗口挑相关能力、注入其详情。
  // 与记忆召回并行跑（各自独立小模型调用、各自超时降级）；不打围栏（是关于 Oru 自己的当前权威事实）。
  // aside 短聊不注入（与 stableSystemContext 裸模式、capabilityPrompt 同一开关——aside 不做能力问答）。
  const [recallBlock, selfKnowledgeBlock] = args.asideMode
    ? ['', '']
    : await Promise.all([
        buildRecallInjection({
          ownerId: agent.ownerId,
          history,
          // 项目维粗筛（G20）：与快照/运行时上下文同取 effectiveProjectId（当前无对话级归属，
          // 取 getActiveProjectId）——按归属圈定候选，排除明确属于其他项目的往事。
          activeProjectId: effectiveProjectId,
          signal: abortController.signal,
        }),
        buildSelfKnowledgeInjection({
          ownerId: agent.ownerId,
          history,
          signal: abortController.signal,
        }),
      ]);
  const dynamicPart = [memorySnapshot, recallBlock, selfKnowledgeBlock, runtimeContext, args.extraDynamicSystemPrompt]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n---\n\n');
  const systemContext = [stableSystemContext, capabilityPrompt, dynamicPart]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n---\n\n');
  // 快照进缓存：会话级稳定前缀 = stable + 能力 prompt + 记忆快照（低频变化——对话中途
  // record_memory/dream 落盘后下一轮快照就变，第二断点 miss 一次，接受；不冻结快照：
  // 记忆写入立即生效是产品语义，新鲜度优先于缓存）。
  // 仅主对话用它当更长的 cache 边界；子 agent 仍 fork 纯 stableSystemContext（见下 runSubagent）。
  // 用与 systemContext 相同的拼接/过滤，保证 systemContext.startsWith(sessionStableSystemContext)。
  const sessionStableSystemContext = [stableSystemContext, capabilityPrompt, memorySnapshot]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n---\n\n');

  // debug：落 prompt_built。只落 systemContext + 元数据——
  // 真实入参（adapter 之后）由后续 inference_view 事件的 wireHistory 承载。
  round.promptBuilt({
    durationMs: Date.now() - promptBuildStartTs,
    systemContextChars: systemContext.length,
    stableSystemContextChars: stableSystemContext.length,
    systemContext,
  });

  // 撞墙重试：emit 包一层探测，一旦真正流到 UI 的 token 出现就锁住 streamingStarted，
  // 不能再重试（重试会让 UI 看到重复内容）。撞墙错误通常发生在 HTTP 400 阶段，没流过 token，
  // 所以重试是安全的。
  let streamingStarted = false;
  const trackedEmit: typeof emit = (ev) => {
    if (
      ev.type === 'chat.delta' ||
      ev.type === 'chat.toolCall' ||
      ev.type === 'chat.toolResult' ||
      ev.type === 'chat.proposal' ||
      ev.type === 'chat.memoryRecord' ||
      ev.type === 'chat.taskReport'
    ) {
      streamingStarted = true;
    }
    emit(ev);
  };

  // S16 整理（回合入口）：上下文用量到真窗过半就两阶段整理——折叠先行（无损、不调 LLM），
  // 折叠打不住才进有损摘要。window 传真窗，不再 ×0.8（effectiveWindow 已退役）。
  // history 末尾仍是本轮 user 消息（router 调入前已 appendMessage），整理一定保留它。
  // 真窗；模型未知时兜底 200k（原 effectiveWindow 内建的同一默认）
  const window = (await resolveTwinMainContextWindow(backend.modelId)) ?? 200_000;
  let workingHistory = history;

  // G112/G54 弃号重灌：本回合发给 backend 的 history 与厂商会话已知内容不同源（被整理 / 被硬丢 /
  // 会话污染）时，作废 sdkSessionId——上报 null 持久清号 ＋ 置本回合本地标志。作废由 runner 单点执行
  // （唯一知道「history 被动过」的层），backend 不自判。托管后端据「无 resumeId ＋ 有 history」走
  // renderSeedPrompt 重灌整理后视图；HTTP 后端 sdkSessionId 恒为 null，清号是 no-op、零行为变化。
  let sessionInvalidated = false;
  const invalidateSession = async () => {
    if (sessionInvalidated) return;
    sessionInvalidated = true;
    try {
      await onSdkSessionId(null);
    } catch {
      // 清号写盘失败不阻塞主流程——本地标志已置，本回合一律不带 resumeSessionId
    }
  };

  const organized = await organizeContext({
    conversationId: conversation.id,
    history: workingHistory,
    systemContext,
    contextWindow: window,
    force: false,
    ownerId: agent.ownerId,
    agentId: agent.id,
    agentName: agent.name,
  });
  if (organized) {
    workingHistory = organized.trimmedHistory;
    // 整理动过 history（折叠 / 摘要 / 硬丢）→ 弃号重灌，时序在发请求之前（发出后才清、
    // 中途崩溃会留下指向已分叉会话的编号）。托管后端由此走 renderSeedPrompt 灌整理后视图，
    // 折叠的 token 收益与摘要在托管范式下才真生效——「已自动压缩」卡从此是真话。
    await invalidateSession();
    // 折叠水印前移落盘——两次整理之间固定，回合装配按它折叠、前缀逐字节稳定
    await updateFoldedBeforeMessageId(agent.id, conversation.id, organized.foldedBefore);
    // 纯折叠无损、不落卡；仅摘要阶段产卡才广播
    if (organized.notificationMessage && onContextCompressed) {
      try {
        await onContextCompressed(organized.notificationMessage);
      } catch {
        // 落盘 / 广播失败不阻塞主流程——整理本身已完成
      }
    }
  }

  let droppedTurns = 0;
  let passiveCompressed = false;
  // G54：本回合是否已因会话污染重灌过——至多一次，重灌后同回合再报错原样抛给用户。
  let poisonReloaded = false;
  // 中断恢复：sink 收集断点前已成形的产出；每轮重置避免上一次重试的残留污染。
  const partial: PartialTurn = { resultText: '', toolCalls: [] };
  // S03 流式实时落盘：流中把 partial 节流镜像进崩溃恢复草稿；正式落盘（runChatAndPersist）后清草稿。
  const inflight = makeInflightWriter({
    agentId: agent.id,
    convId: conversation.id,
    messageId,
    startedAt: turnStartedAt,
    meta: {
      backendType: backend.backendType,
      toolProtocol: backend.toolProtocol,
      modelId: backend.modelId,
      providerId: backend.providerId,
    },
  });
  try {
    while (true) {
      partial.resultText = '';
      partial.toolCalls = [];
      // 撞墙第一次 retry 时已经走过被动压缩；之后用 dropOldestTurns 兜底
      const trimmedHistory = dropOldestTurns(workingHistory, droppedTurns);
      try {
        // 主对话 ToolContext 的「继承组」：一次构建，既 `...inherited` spread 进本回合 toolContext，
        // 又整组交给 runSubagent 闭包透传给 subagent——消灭「主 ctx / deps / subagent ctx」三处手抄清单。
        // activatedPlugins 取当前 workingHistory 快照：plugin-activate chip 在 Tier 1 折叠 + compress
        // 白名单内不会消失，故一轮内该集合稳定，主对话与 subagent 共享同一份快照安全。
        const inherited: InheritedToolContext = {
          onMemoryRecord,
          onGitHint,
          onArtifactSubmissionChanged,
          onProposal,
          onProposalTrace,
          onProposalOutcome,
          onSkillEvent,
          askUserChoice,
          onCircuitBreak,
          activatedPlugins: rebuildActivatedPlugins(workingHistory),
        };
        const handle = backend.runConversation({
          agentId: agent.id,
          conversationId: conversation.id,
          userMessage: userText,
          history: trimmedHistory,
          systemContext: systemContext || undefined,
          stableSystemContext: stableSystemContext || undefined,
          // 主对话额外传更长的会话级稳定段（含快照）作第二缓存边界；子 agent 不传此字段。
          sessionStableSystemContext: sessionStableSystemContext || undefined,
          // 本回合作废过编号（整理 / 污染重灌）→ 一律不带 resumeSessionId，逼 backend 走重灌。
          // 读的是回合开始的内存快照 conversation.sdkSessionId，只清 store 不足以挡住 continue
          // 重试仍带旧编号——本地标志才是承重判断（仓库「await 后重检共享状态」约定）。
          resumeSessionId: sessionInvalidated ? undefined : (conversation.sdkSessionId ?? undefined),
          cwd: agent.homePath,
          abortController,
          // 主对话：用户在实时看输出 → 开逐 token 流式（仅 claude-code 后端据此开 partial）。
          streaming: true,
          toolContext: {
            // 能力供给的 ToolContext patch（联网：searchBudgetId）——放最前，显式字段优先
            ...provision.toolContextPatch,
            // 眼睛锚定的焦点 deck 路径（任务 9 决策 3）；无活跃提交组时不设，工具优雅 isError
            ...(deckPath ? { deckPath } : {}),
            // 继承组（字段见 InheritedToolContext）——同一份 inherited 也交给下方 runSubagent
            // 闭包，主对话与 subagent 两处永不漂移。
            ...inherited,
            conversationId: conversation.id,
            agentId: agent.id,
            ownerId: agent.ownerId,
            activeProjectId: effectiveProjectId ?? undefined,
            usage: 'twinMain',
            approvalMode: agent.approvalMode,
            abortSignal: abortController.signal,
            // 前台命令实时输出（G19）：推给 UI 滚动显示，只给人看（模型到 tool_result 才拿到内容）。
            onCommandOutput: (chunk) =>
              trackedEmit({
                type: 'chat.commandOutput',
                conversationId: conversation.id,
                messageId,
                chunk,
              }),
            // 计划清单（S32·G49）：AI 更新 todo 时推给 UI 展示（纯展示，overwrite 覆盖式）。
            onTodoUpdate: (items) => trackedEmit({ type: 'chat.todo', conversationId: conversation.id, items }),
            boardCurrentTaskId: args.boardCurrentTaskId,
            conversationCreatedAt: conversation.createdAt,
            // 对话期 Subagent（v2）：闭包捕获主对话 deps，让 Task 工具能派 subagent。
            // subagent 自己的 ToolContext 不挂此字段（嵌套保护）。
            runSubagent: args.subagentSupport
              ? (req) =>
                  runSubagent(req, {
                    conversationId: conversation.id,
                    agentId: agent.id,
                    agentName: agent.name,
                    ownerId: agent.ownerId,
                    backend,
                    parentStableSystemContext: stableSystemContext,
                    cwd: agent.homePath,
                    activeProjectId: effectiveProjectId ?? undefined,
                    approvalMode: agent.approvalMode,
                    abortSignal: abortController.signal,
                    // 继承组整组透传（字段见 InheritedToolContext）——与主对话 toolContext 同一份
                    // inherited，漏传在结构上不可能。
                    inherited,
                    broadcastChip: args.subagentSupport!.broadcastChip,
                    persistChip: args.subagentSupport!.persistChip,
                  })
              : undefined,
          },
          // 能力供给的 disallowed（联网：禁 SDK 内置 WebSearch/WebFetch，避免与 oru 工具两套并存）。
          // ask_twin（G72）：主对话回合屏蔽——它只给对话期 subagent 用（主 agent 不该反问自己）。
          disallowedTools: ['ask_twin', ...(args.extraToolDenylist ?? []), ...provision.extraDisallowed],
          // 随手评点（aside）只读白名单——backend 在工具列表层收口（undefined 不收口）
          restrictToolsTo: args.restrictToolsTo,
          disableReasoning,
          // Steering：动作边界 drain（anthropic/openai 在 tool_result 边界搭车注入；
          // claude-code 在 interrupt 截断后落盘续喂）+ 待读入探测（claude-code 决定是否 interrupt）
          drainSteering: args.drainSteering,
          hasPendingSteering: args.hasPendingSteering,
          // 边界系统通知（后台终态随 steering 同边界注入）
          drainBoundaryNotice: args.drainBoundaryNotice,
          // 续发检查点（S16 G66）：HTTP 两后端在每次续发前调此闭包——估算 seed + in-flight 是否超水位，
          // 超则两阶段整理 seed 并返回，backend 就地 replaceSeedHistory（in-flight 逐字节保留）。
          // 返回 null=照发。claude-code 走 SDK 内部循环、不调此钩子（其内建 auto-compact 兜住回合中途）。
          onBeforeContinuation: async ({ reason }) => {
            // in-flight 产出（本轮 assistant 文本 + 工具回执）的粗估——JSON.stringify 保守高估
            const inflightTokens =
              estimateTokens(partial.resultText) + estimateTokens(JSON.stringify(partial.toolCalls));
            const organized = await organizeContext({
              conversationId: conversation.id,
              history: workingHistory,
              systemContext,
              contextWindow: window,
              force: reason === 'overflow',
              extraTokens: inflightTokens,
              ownerId: agent.ownerId,
              agentId: agent.id,
              agentName: agent.name,
            });
            if (!organized) return null;
            // 此处不弃号：续发钩子只 HTTP 两后端调用（claude-code 走 SDK 内部循环、不挂此钩子，见上），
            // HTTP 无 sdkSessionId、就地 replaceSeedHistory 即生效——弃号重灌是托管后端专属路径。
            // 同步 runner 本地态：整理后视图与水印落定，供本回合结束后的外层兜底路径读到最新值
            // （await 后重检共享状态——回合结束交还 runner 时不得再用整理前的旧 workingHistory）
            workingHistory = organized.trimmedHistory;
            await updateFoldedBeforeMessageId(agent.id, conversation.id, organized.foldedBefore);
            if (organized.notificationMessage && onContextCompressed) {
              try {
                await onContextCompressed(organized.notificationMessage);
              } catch {
                // 落盘 / 广播失败不阻塞续发
              }
            }
            return organized.trimmedHistory;
          },
          onInferenceView: (info) => round.inferenceView(info),
          // 所有运行时元数据（时间 / 项目环境 / 未播报 task）已通过 systemContext 注入，
          // 不再依赖 SDK 的 SessionStart / UserPromptSubmit hook
        });
        // debug：每次新 handle 都新建 deriver，retry 时 FSM 状态自然 reset
        const deriver = round.makeStreamDeriver({
          backendType: backend.backendType,
          modelId: backend.modelId,
          providerId: backend.providerId,
        });
        const wrappedEvents = teeAndDerive(handle.events, deriver);
        const result = await pipeSdkToEvents(
          wrappedEvents,
          {
            conversationId: conversation.id,
            messageId,
            ownerId: agent.ownerId,
            agentId: agent.id,
            emit: trackedEmit,
            onSdkSessionId,
            onPartialUpdate: () => {
              inflight.write(partial);
              // 唤醒对账：同步内存镜像（含最后一小段未节流写盘的完整半截）+ 本回合 messageId。
              // 只在本轮有产出时留档（partial 为空时 readActivePartial 自会过滤）。
              activePartials.set(activeKey(agent.id, conversation.id), { messageId, partial });
            },
          },
          partial,
        );
        round.done({ hadError: result.isError });
        return {
          resultText: result.resultText,
          isError: result.isError,
          toolCalls: result.toolCalls,
          sawReasoning: result.sawReasoning,
          backendType: backend.backendType,
          toolProtocol: backend.toolProtocol,
          modelId: backend.modelId,
          providerId: backend.providerId,
        };
      } catch (e) {
        // G54 会话污染：backend 事件层判定后抛 SessionPoisonError。本回合未重灌过 → 清号 ＋ 置本地
        // 标志 → continue 重试，backend 无 resumeId 走重灌同路径。重灌后再遇报错不再吃、原样抛
        //（重灌的组装侧本就有滤空块等源头预防，再炸是别的问题，掩盖有害）。留痕原始毒化文案供排查。
        if (e instanceof SessionPoisonError && !poisonReloaded) {
          poisonReloaded = true;
          // 留痕原始毒化文案，供排查模式清单漏配（记忆 project_claudecode_session_poison）
          console.warn(
            `[session-poison] auto-reload conv=${conversation.id}: ${e.rawText.slice(0, 300)}`,
          );
          await invalidateSession();
          continue;
        }

        if (!isContextOverflowError(e) || streamingStarted) throw e;

        // 第一次撞墙：跑被动整理（force=true），不算 droppedTurns
        if (!passiveCompressed) {
          passiveCompressed = true;
          const passive = await organizeContext({
            conversationId: conversation.id,
            history: workingHistory,
            systemContext,
            contextWindow: window,
            force: true,
            ownerId: agent.ownerId,
            agentId: agent.id,
            agentName: agent.name,
          });
          if (passive) {
            workingHistory = passive.trimmedHistory;
            // 被动整理动过 history → 弃号重灌（同回合入口整理），托管后端灌整理后视图
            await invalidateSession();
            await updateFoldedBeforeMessageId(agent.id, conversation.id, passive.foldedBefore);
            if (passive.notificationMessage && onContextCompressed) {
              try {
                await onContextCompressed(passive.notificationMessage);
              } catch {
                // 落盘 / 广播失败不阻塞重试
              }
            }
            continue;
          }
        }

        // 被动压缩跑过了仍超 → 走兜底硬丢
        if (
          droppedTurns < MAX_OVERFLOW_RETRIES &&
          countUserTurns(trimmedHistory) > 1
        ) {
          droppedTurns += 1;
          // 硬丢整轮地把老消息从发送视图里拿掉，落在其中的 read_file 结果一并离场——
          // 与折叠/摘要同性质，故同样推进上下文代际（否则 read_file 的去重仍会回一句
          // 「参考上次读取的内容」，而模型早已看不到那份内容）。organizeContext 里那两处
          // 自增覆盖不到这条路：走到这里的前提正是它返回了 null。
          invalidatePriorReads(conversation.id);
          // 硬丢改变了发给 backend 的 history（droppedTurns > 0）→ 弃号重灌
          await invalidateSession();
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    // debug：落错误 + 收尾
    const errPhase = abortController.signal.aborted
      ? ('stream' as const)
      : isContextOverflowError(e)
        ? ('llm' as const)
        : ('unknown' as const);
    round.error({
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
      phase: errPhase,
    });
    round.done({ hadError: true });
    // overflow 走专门的错误码 + 中文文案，前端能识别并给友好提示
    const isOverflow = isContextOverflowError(e);
    const message = isOverflow
      ? '对话长度已达模型上下文上限——压缩 + 兜底硬丢仍无法装下。建议新开对话或精简单条消息。'
      : (e instanceof Error ? e.message : String(e));
    const err = new Error(message) as Error & { code?: string };
    err.code = isOverflow ? ErrorCodes.CONTEXT_OVERFLOW : ErrorCodes.AGENT_FAILED;
    // 中断恢复：把中断信息挂到错误上（不改 message/code），让 runChatAndPersist 落 incomplete。
    // 用户 abort（signal 已置）即使半截为空也挂——reason='aborted' 是下游区分「用户自己按的停」
    // 与真错误的唯一依据（按 signal 状态判定，三个 backend 的 abort 错误文案各异，不靠字符串匹配）；
    // 空半截 buildInterruptedMessage 返回 null，不会落空壳。
    // overflow 等「未产出就失败」的非 abort 错误 partial 为空，维持不挂。
    const userAborted = abortController.signal.aborted;
    if (userAborted || partial.resultText.length > 0 || partial.toolCalls.length > 0) {
      attachInterruptedTurn(err, {
        partial: { resultText: partial.resultText, toolCalls: partial.toolCalls },
        reason: userAborted ? 'aborted' : 'upstream_error',
        meta: {
          backendType: backend.backendType,
          toolProtocol: backend.toolProtocol,
          modelId: backend.modelId,
          providerId: backend.providerId,
        },
      });
    }
    throw err;
  } finally {
    // 回合结束（成功 / 抛出）：停掉草稿写手——取消待写定时器、等在途写盘落定，
    // 之后 runChatAndPersist 清草稿不会被复活。清草稿本身在 runChatAndPersist 正式落盘后做。
    await inflight.stop();
  }
}

function countUserTurns(history: ChatMessage[]): number {
  let n = 0;
  for (const m of history) if (m.role === 'user') n += 1;
  return n;
}

/**
 * 拿当前 twinMain backend 的 contextWindow——整理水位判定用真窗（G62）。
 * modelId 缺失（OAuth 走 SDK 默认）→ 200_000 兜底；找不到对应 RegisteredModel → 同样兜底。
 */
async function resolveTwinMainContextWindow(modelId: string | undefined): Promise<number | undefined> {
  if (!modelId) return undefined;
  try {
    const settings = await getSettings();
    const model = settings.models.find((m) => m.id === modelId);
    return model?.contextWindow;
  } catch {
    return undefined;
  }
}
