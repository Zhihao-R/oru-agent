/**
 * 起一次独立的 Twin 后台 LLM 调用，不污染主对话 session
 * - 用于 askTwinBridge（子 agent 反问主 Oru）
 * - 通过 backend factory（usage='twinBackground'）走当前用户配置的 backend
 * - 工具：背景 Twin 注册的工具（list_projects / get_project_detail / escalate_to_user / 记忆三件套）
 *   都通过 factory 静态注册，按 usages 白名单过滤
 * - 不消费 conversation history（背景 query 是独立的）
 */
import { getBackendFor } from './backends';
import { instrumentConversation } from '../debug/instrument';
import { runQueryOnce } from './stream';
import { sessionStartHandler } from './hooks';
import { provisionAgent } from './capabilities';
import { loadMcpPromptIfEnabled, buildUnreachableNote } from './mcpPrompt';
import { finalizeConversationBudget } from '../search/budget';
import type { EscalateHandler } from './oruMcpFactory';
import { getAgent } from '../agent/store/agents';
import { singleUserTurn } from './singleUserTurn';
import { withIdleWatchdog, STREAM_IDLE_TIMEOUT_MS } from './util/idleWatchdog';

export type TwinBackgroundResult = {
  resultText: string;
  isError: boolean;
};

export type RunTwinBackgroundArgs = {
  agentId: string;
  prompt: string;
  /** 当 background Twin 想 escalate 时的入口；为 null 表示不让它 escalate */
  taskId: string | null;
  escalateHandler: EscalateHandler | null;
  /** 外部 AbortController，调用方可主动 abort（cancelTwinWait） */
  abortController?: AbortController;
};

let activeRunFn: (args: RunTwinBackgroundArgs) => Promise<TwinBackgroundResult> = realRunTwinBackground;

/**
 * 公开的入口；askTwinBridge 调这个
 * 测试可以用 __setRunBackgroundForTest 把内部实现换成 mock
 */
export function runTwinBackground(args: RunTwinBackgroundArgs): Promise<TwinBackgroundResult> {
  return activeRunFn(args);
}

/** 仅 smoke 测试用：临时换掉 background Twin 的真实实现 */
export function __setRunBackgroundForTest(
  fn: (args: RunTwinBackgroundArgs) => Promise<TwinBackgroundResult>,
): () => void {
  const prev = activeRunFn;
  activeRunFn = fn;
  return () => {
    activeRunFn = prev;
  };
}

async function realRunTwinBackground(args: RunTwinBackgroundArgs): Promise<TwinBackgroundResult> {
  const agent = await getAgent(args.agentId);
  const backend = await getBackendFor('twinBackground');
  const ready = await backend.isReady();
  if (!ready.ok) {
    return { resultText: `[BACKGROUND_AUTH_FAIL] ${ready.hint}`, isError: true };
  }

  const abortController = args.abortController ?? new AbortController();

  // 背景 query 每次一个独立 conversationId（带 timestamp 自然独立）
  const bgConversationId = `bg_${args.taskId ?? 'noTask'}_${Date.now()}`;

  // 声明式能力 · 阶段二（usage=twinBackground）：联网引导 prompt + 预算桶 reset + 禁 SDK 内置。
  // 背景 Twin 也在联网能力 audience 里——经同一机制供给，避免"工具迁了、prompt/disallow 没迁"的半截不一致。
  const provision = await provisionAgent({
    usage: 'twinBackground',
    searchBudgetId: bgConversationId,
    activeProjectId: null,
  });
  const mcpPrompt = await loadMcpPromptIfEnabled();
  // MCP 不可达点名拼进尾部：背景 Twin 持有外部 MCP 工具，一次性会话无缓存代价，
  // 不能退回没有警示的状态。
  const mcpDownNote = await buildUnreachableNote();
  const systemContext = [agent.systemPromptAppend, provision.capabilityPrompt, mcpPrompt, mcpDownNote]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n---\n\n');

  try {
    const handle = backend.runConversation({
      agentId: agent.id,
      conversationId: bgConversationId,
      userMessage: args.prompt,
      // 背景 query 无历史，但 prompt 必须作为 history 末尾 user 轮：非 claudeCode 后端只读
      // history、不读 userMessage（见 singleUserTurn 注释）
      history: singleUserTurn(bgConversationId, args.prompt),
      systemContext: systemContext || undefined,
      cwd: agent.homePath,
      abortController,
      // 能力供给的 disallowed（联网：禁 SDK 内置 WebSearch/WebFetch，避免与 oru 工具两套并存）
      disallowedTools: provision.extraDisallowed,
      toolContext: {
        // 能力供给的 ToolContext patch（联网：searchBudgetId=bgConversationId，与本桶一致）
        ...provision.toolContextPatch,
        conversationId: bgConversationId,
        agentId: agent.id,
        ownerId: agent.ownerId,
        usage: 'twinBackground',
        approvalMode: 'work',  // 背景查询不弹 propose 卡片（等价旧 requireApproval=false）
        abortSignal: abortController.signal,
        taskId: args.taskId ?? undefined,
        escalateHandler: args.escalateHandler ?? undefined,
      },
      // 背景 query 不挂 UserPromptSubmit hint（项目 hint / 未播报 task 都是主对话用的，
      // 离线判断不需要这些上下文）
      onSessionStart: async () => {
        const r = await sessionStartHandler({ eventName: 'SessionStart' });
        return r ?? {};
      },
    });
    const events = instrumentConversation(
      backend,
      {
        roundId: bgConversationId,
        conversationId: bgConversationId,
        ownerId: agent.ownerId,
        agentId: agent.id,
        agentName: agent.name,
        source: 'background',
        userText: args.prompt,
      },
      handle.events,
      systemContext || undefined,
    );
    // 空闲看门狗：静默（卡死）超阈值才 abort，还在查就不杀——缘由见 idleWatchdog.ts
    const r = await runQueryOnce(
      withIdleWatchdog(events, STREAM_IDLE_TIMEOUT_MS, () => abortController.abort()),
    );
    return r;
  } catch (e) {
    return {
      resultText: `[BACKGROUND_ERROR] ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  } finally {
    // 一次性 bg conversationId 用完即弃，删 budget Map entry 避免泄漏
    finalizeConversationBudget(bgConversationId);
  }
}
