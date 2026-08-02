/**
 * 定时任务后台执行体（S18·G98/G43）——到点即后台开跑，机制与后台派工（subagentRunner）同套：
 * 独立 backend 会话（一次性 conversationId `sched_<taskId>_<id>`）、带一份承载对话的历史快照做上下文、
 * 审批卡回流承载对话、错误照常分类。不占对话回合、不进统一队列。
 *
 * 三段执行链里本模块是「后台执行体 → 结果落盘」两段：
 *  1. spawnScheduledRun：同步 inflight 串行合并 + 占位，fire-and-forget 起 driveRun（不 await 执行完成）。
 *  2. driveRun：开跑前重验 → 确定承载对话 + 快照 + 广播「执行中」→ 跑会话 → 结算（G43 单点）→ 结果落盘
 *     → 释放 inflight → 结算后重扫（账非空再 drain 一轮，兜孤账竞态）。
 *
 * 执行体不随重启存活：inflight 只在内存，应用退出 abortAllScheduledRuns 逐个 abort，**退出中止不结算**
 * ——不与进程退出赛跑写盘，账留给下次开机对账收编为错过，结局单一确定。由此新路径不产生 lastRun.status='aborted'。
 *
 * 编排（driveRun）参数化在注入的 ExecutorDeps 上便于单测；生产 deps 在 index.ts 经 makeScheduledExecutorDeps
 * 装配（store 原语 + 承载对话解析 + 真 runConversation 适配器）。
 */
import type { ActionProposal, ChatMessage, ScheduledTask } from '@shared/types';
import type { AgentBackend, ConversationEvent, ToolContext } from '@shared/agent/backend';
import type { Broadcast } from '../ws/server';
import { newMessageId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { getAgent } from '../agent/store/agents';
import { getSettings } from '../projects/store';
import { resolveEffectiveLang } from '../i18n/effectiveLang';
import { getBackendFor } from '../agent/backends';
import { provisionAgent } from '../agent/capabilities';
import { buildStableSystemContext } from '../agent/stableSystemContext';
import { loadMcpPromptIfEnabled, buildUnreachableNote } from '../agent/mcpPrompt';
import { MEMORY_B_PATH_INSTRUCTION } from '../prompts/memoryBPath';
import { finalizeConversationBudget } from '../search/budget';
import { surfaceProposal } from '../proposals/registry';
import { instrumentConversation } from '../debug/instrument';
import { buildCurrentTimeLine } from '../agent/hooks';
import {
  appendMessage as appendConvMessage,
  createSubConversation,
  getConversation,
  getOrCreateConversation,
  readHistoryForLLM,
} from '../conversations/store';
import { pushConvState } from '../ws/handlers/convState';
import { deliverToChannel } from '../platform/outbound';
import { listAgents } from '../agent/store/agents';
import { t } from '../i18n/t';
import {
  getScheduledTask,
  settleRun as storeSettleRun,
  discardFires as storeDiscardFires,
  patchScheduledTask,
} from './store';
import { describeFrequency } from '@shared/scheduledTasks/describe';
import { tFor } from '../i18n/t';

/** 执行体产出：最终文字 + 成败（新路径不产生 'aborted'——退出中止不结算，见模块头）。 */
export type ScheduledRunResult = { text: string; status: 'ok' | 'error'; error?: string };

export interface ExecutorDeps {
  now(): number;
  /** 开跑前重验：按 id 重读最新任务。 */
  getTask(id: string): Promise<ScheduledTask | null>;
  /** 结算（G43 单点）：lastRun + 销账 + 计次（store.settleRun）。 */
  settleRun(
    id: string,
    run: NonNullable<ScheduledTask['lastRun']>,
    opts?: { clearMissed?: boolean; conversationId?: string },
  ): Promise<ScheduledTask | null>;
  /** 重验失败丢弃账（store.discardFires）。 */
  discardFires(id: string): Promise<void>;
  /** 手动执行撞进行中的执行体时清 missedAt（§5：撞上不另起、立即清 missedAt）。 */
  clearMissed(id: string): Promise<void>;
  /** 确定承载对话（归档判定迁入；新建落点当场创建）。返回落点 agentId + conversationId。 */
  resolveConversation(task: ScheduledTask): Promise<{ agentId: string; conversationId: string }>;
  /**
   * 落盘前重验并敲定最终承载对话：原对话在跑会话期间被归档/删除则重解析（归档不翻出、不解档）。
   * 结算与落盘都用它返回的对话，运行记录的 conversationId 才钉到产出真正落盘处（G45「查看产出」不指错）。
   */
  ensureLandable(
    agentId: string,
    conversationId: string,
    task: ScheduledTask,
  ): Promise<{ agentId: string; conversationId: string }>;
  /** 取承载对话的 marker 后视野作历史快照（readHistoryForLLM）。 */
  readSnapshot(agentId: string, conversationId: string): Promise<ChatMessage[]>;
  /** 跑一段后台会话（backend.runConversation + 消费事件流 + 审批回流），返回最终产出与成败。 */
  runConversation(p: {
    task: ScheduledTask;
    agentId: string;
    conversationId: string;
    snapshot: ChatMessage[];
    late: boolean;
    abortController: AbortController;
  }): Promise<ScheduledRunResult>;
  /** 结果直接落盘承载对话：结果卡 + 可选产出消息 + finished 广播（落盘前重验承载对话仍可用）。 */
  landResult(p: {
    agentId: string;
    conversationId: string;
    task: ScheduledTask;
    result: ScheduledRunResult;
  }): Promise<void>;
  /** 开跑广播「执行中」临时态（不落历史）。 */
  broadcastStarted(p: { conversationId: string; taskId: string; title: string }): void;
  /** 任何改动 store 后回调（广播全端最新状态）；可选。 */
  onStateChanged?(): void | Promise<void>;
}

// ─── 模块级：deps 注入 + inflight 串行护栏 ─────────────────────────────
let deps: ExecutorDeps | null = null;
/** 同任务串行合并的凭据：taskId → 该执行体的中止句柄。同任务已在跑则不另起（账留着合并结算）。 */
const inflight = new Map<string, AbortController>();

export function configureExecutor(d: ExecutorDeps | null): void {
  deps = d;
}

/** 当前后台执行中的任务 id（inflight RPC 用；应用重启执行体不存活、返回空）。 */
export function getInflightScheduledRuns(): string[] {
  return [...inflight.keys()];
}

/** 应用退出：逐个 abort（退出中止不结算，账留给开机对账收编为错过）。 */
export function abortAllScheduledRuns(): void {
  for (const ac of inflight.values()) ac.abort();
  inflight.clear();
}

/**
 * 后台执行体入口（scheduler 到点 与 runTaskNow 手动共用）。同步做串行合并与占位，返回是否撞上
 * 进行中的执行体；实际跑完在后台，不 await（tick 不被执行拖住）。
 * - 已被占（同任务在跑）：直接返回 alreadyRunning——到点拍的账已在 pendingFires，随进行中的执行一并
 *   结算、计一；手动撞上则立即清 missedAt（§5，用户的「立即执行」意图由进行中的那次消化）。
 */
export function spawnScheduledRun(
  taskId: string,
  opts: { manual?: boolean; late?: boolean },
): { alreadyRunning: boolean } {
  const d = deps;
  if (!d) return { alreadyRunning: false }; // 未装配（背景/未 configure）——静默不跑
  if (inflight.has(taskId)) {
    if (opts.manual) void d.clearMissed(taskId).catch(() => undefined);
    return { alreadyRunning: true };
  }
  const ac = new AbortController();
  inflight.set(taskId, ac);
  void driveRun(d, taskId, opts, ac).catch((e) =>
    console.warn(`[scheduledRun] 执行体异常 task=${taskId}`, e),
  );
  return { alreadyRunning: false };
}

/**
 * 执行体主流程（§6）。先占位后重验——占位已在 spawnScheduledRun 完成，这里从重验开始。
 * 承重顺序：重验失败即 discardFires（结算滞后多投出去的一拍在此兜住）；退出中止（ac.aborted）
 * 一律不结算、不落结果，账留给开机对账。
 */
async function driveRun(
  d: ExecutorDeps,
  taskId: string,
  opts: { manual?: boolean; late?: boolean },
  ac: AbortController,
): Promise<void> {
  const late = opts.late ?? false;
  try {
    // ① 开跑前重验：到点拍要求 存在 && enabled && 未跑满；手动批只查存在（暂停/跑满不静默失效，§5）。
    const task = await d.getTask(taskId);
    const valid = opts.manual
      ? !!task
      : !!task &&
        task.enabled &&
        (task.stopAfterRuns == null || task.runCount < task.stopAfterRuns);
    if (!task || !valid) {
      if (!opts.manual) await d.discardFires(taskId); // 到点拍重验失败：销账、不计次
      await d.onStateChanged?.();
      return;
    }

    // ② 确定承载对话 + 快照 + 广播「执行中」
    const { agentId, conversationId } = await d.resolveConversation(task);
    const snapshot = await d.readSnapshot(agentId, conversationId);
    d.broadcastStarted({ conversationId, taskId, title: task.title });

    // ③ 跑会话
    let result: ScheduledRunResult;
    try {
      result = await d.runConversation({ task, agentId, conversationId, snapshot, late, abortController: ac });
    } catch (e) {
      if (ac.signal.aborted) return; // 退出中止：不结算、不落结果（finally 删 inflight，账留给 boot）
      result = { text: '', status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
    if (ac.signal.aborted) return; // 跑完瞬间被中止：同样不结算

    // ④’ 敲定最终承载对话（原对话跑会话期间可能被归档/删除 → 重解析）。结算与落盘都用它——
    //     运行记录里的 conversationId 才钉到产出真正落盘处（G45），不指向被换掉的旧对话。
    const landing = await d.ensureLandable(agentId, conversationId, task);
    // ④ 结算（G43 单点）：成/败都结算——lastRun + 销当前全部账 + 到点账≥1 计一次；late 连带清 missedAt。
    await d.settleRun(
      taskId,
      { at: d.now(), status: result.status, error: result.error, late },
      { clearMissed: late, conversationId: landing.conversationId }, // G45：运行记录带上产出承载对话
    );
    // ⑤ 结果直接落盘承载对话（不占回合、不排队）
    await d.landResult({ agentId: landing.agentId, conversationId: landing.conversationId, task, result });
    await d.onStateChanged?.();
  } finally {
    if (inflight.get(taskId) === ac) inflight.delete(taskId);
  }

  // ⑥ 结算后重扫（§6.7）：inflight 已删，重读账非空即再 drain 一轮——兜「账落在结算读取之后、
  // spawn 判定之前」的窄窗（否则该拍成孤账，要等下次重启才被对账当错过收编）。退出中止不重扫。
  if (!ac.signal.aborted) {
    const latest = await d.getTask(taskId);
    if (latest && (latest.pendingFires ?? []).length > 0) {
      spawnScheduledRun(taskId, { manual: false, late: false });
    }
  }
}

// ─── 历史快照注入（跨后端契约）──────────────────────────────────────
/**
 * 组装喂给 backend 的 history：承载对话快照 + 触发轮（同时作为 history 末尾 user 轮）。
 * ConversationInput 契约「当前 user 轮 = history 末尾 user 消息」——只有 claudeCode 兜底读 userMessage，
 * anthropic/openaiCompatible 只 replay history。触发文本作为末尾 user 轮化解这唯一的跨后端坑
 * （与 singleUserTurn 同一约定），三后端零特判。
 */
export function buildScheduledHistory(
  snapshot: ChatMessage[],
  conversationId: string,
  triggerText: string,
): ChatMessage[] {
  return [
    ...snapshot,
    {
      id: newMessageId(),
      conversationId,
      role: 'user',
      text: triggerText,
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    },
  ];
}

// ─── 事件流消费：收集最终文字 + 判成败（对齐 pipeSdkToEventsForTask，但不写任务面板）──────
async function consumeRun(
  events: AsyncIterable<ConversationEvent>,
  ac: AbortController,
): Promise<ScheduledRunResult> {
  let assembled = '';
  let resultText = '';
  let isError = false;
  try {
    for await (const ev of events) {
      if (ev.type === 'assistant_text') assembled += ev.text;
      else if (ev.type === 'result') {
        if (ev.resultText) resultText = ev.resultText;
        if (ev.isError) isError = true;
      }
    }
  } catch (e) {
    if (ac.signal.aborted) throw e; // 退出中止：透传给 driveRun 判 aborted（不结算）
    // 流中途抛（claudeCode 子进程退出最典型）：优先拿 isError result 的文本当真因
    if (isError && resultText.trim()) return { text: '', status: 'error', error: resultText.trim() };
    return { text: '', status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
  const text = (resultText || assembled).trim();
  if (isError) return { text: '', status: 'error', error: resultText.trim() || '执行体报告失败但未给出原因' };
  return { text, status: 'ok' };
}

/**
 * 真 runConversation 适配器（生产 ExecutorDeps.runConversation）：起 backend.runConversation、
 * 消费事件流、审批回流承载对话。执行体就是「这个 Oru」——systemContext = 人设 + 能力供给（usage
 * =scheduledRun，透明继承 twinMain 工具含 Task/bash）；历史快照经 history 注入，三后端零特判。
 * resolveBackend 可注入便于单测；生产走 getBackendFor（自动按 usage 计量，S13）。
 */
export async function runScheduledConversation(
  p: {
    task: ScheduledTask;
    agentId: string;
    conversationId: string;
    snapshot: ChatMessage[];
    late: boolean;
    abortController: AbortController;
  },
  broadcast: Broadcast,
  resolveBackend: (usage: 'scheduledRun') => Promise<AgentBackend> = getBackendFor,
): Promise<ScheduledRunResult> {
  const { task, agentId, conversationId, snapshot, late, abortController } = p;
  const runConvId = `sched_${task.id}_${newMessageId()}`;
  try {
    const backend = await resolveBackend('scheduledRun');
    const ready = await backend.isReady();
    if (!ready.ok) return { text: '', status: 'error', error: ready.hint };

    const agent = await getAgent(agentId);
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    const triggerText = renderTriggerEvent(
      task,
      { late, dueAt: task.missedAt },
      (at) => fmtDueAt(at, lang),
      lang,
    );
    const history = buildScheduledHistory(snapshot, runConvId, triggerText);

    const provision = await provisionAgent({
      usage: 'scheduledRun',
      searchBudgetId: runConvId,
      activeProjectId: null,
    });
    const mcpPrompt = await loadMcpPromptIfEnabled();
    const stable = await buildStableSystemContext({
      agentSystemPromptAppend: agent.systemPromptAppend,
      memoryBPathInstruction: MEMORY_B_PATH_INSTRUCTION,
      mcpPrompt,
    });
    // systemContext = 人设 + 能力供给 + 当前时间。不带 memory snapshot / recall（主对话每轮才走）：
    // 执行体带的是「承载对话历史快照」做上下文（history 注入），一次性触发轮里再跑记忆召回收益低、徒增延迟。
    // 但「当前时间」必须补——定时产出天然时间相关（今日日报 / 迟到多久），且执行体不走主对话的 buildRuntimeContext
    // 时间注入、SDK 会话也无 onSessionStart，这是它知悉「现在几点」的唯一通道。
    // MCP 不可达点名并进运行时块：执行体持有外部 MCP 工具，一次性会话无缓存代价，
    // 不能退回没有警示的状态。
    const mcpDownNote = await buildUnreachableNote();
    const runtimeBlock = [`[运行时上下文]\n${buildCurrentTimeLine()}`, mcpDownNote]
      .filter((s) => s.trim().length > 0)
      .join('\n\n');
    const systemContext = [stable, provision.capabilityPrompt, runtimeBlock]
      .filter((s) => s && s.trim().length > 0)
      .join('\n\n---\n\n');

    // 审批回流承载对话（照 subagentRunner.onSubagentProposal）：proposal.conversationId 改写为承载对话，
    // 带「来自定时任务〈标题〉」标注（triggeredByScheduledTask）。挡位实时 getAgent（emitProposal 内）。
    const onProposal = async (pr: ActionProposal): Promise<void> => {
      const routed: ActionProposal = {
        ...pr,
        conversationId,
        triggeredByScheduledTask: { taskId: task.id, title: task.title },
      };
      try {
        surfaceProposal(routed, broadcast);
      } catch (e) {
        console.warn(`[scheduledRun] 审批卡回流失败 task=${task.id}（不影响执行）:`, e);
      }
    };

    // 装卸类的两条收尾通道也要挂——它们原本埋在各执行器内部，收敛到统一落点后，同步路径只有
    // 这两个回调能到达。不挂的后果：定时任务装 plugin / skill 时对话流没 chip、拓展页不刷新，
    // 全放挡下连一张记录卡都没有，用户完全看不见发生过什么。
    const onProposalOutcome = async (
      pr: ActionProposal,
      outcome: Parameters<NonNullable<ToolContext['onProposalOutcome']>>[1],
    ): Promise<void> => {
      const { writeProposalOutcomeChip } = await import('../proposals/outcomeChip');
      await writeProposalOutcomeChip({ ...pr, conversationId }, outcome, broadcast);
    };
    const onProposalTrace = async (pr: ActionProposal): Promise<void> => {
      // 与 onProposal 同样改写到承载对话 + 带上定时任务溯源标注（它不经 surfaceProposal，故在此自广播）。
      const routed: ActionProposal = {
        ...pr,
        conversationId,
        triggeredByScheduledTask: { taskId: task.id, title: task.title },
      };
      broadcast({ type: 'chat.proposal', conversationId, proposal: routed });
    };

    const handle = backend.runConversation({
      agentId,
      conversationId: runConvId,
      userMessage: triggerText,
      history,
      systemContext,
      cwd: agent.homePath,
      abortController,
      disallowedTools: provision.extraDisallowed,
      toolContext: {
        ...provision.toolContextPatch,
        conversationId: runConvId,
        agentId,
        ownerId: getCurrentOwnerId(),
        usage: 'scheduledRun',
        approvalMode: agent.approvalMode,
        abortSignal: abortController.signal,
        onProposal,
        onProposalTrace,
        onProposalOutcome,
      },
    });
    // 接调试日志（与后台派工同构）：LLM 调用点经 instrumentConversation 落 debug round，可在调试面板回看。
    const events = instrumentConversation(
      backend,
      {
        roundId: newMessageId(),
        conversationId: runConvId,
        ownerId: getCurrentOwnerId(),
        agentId,
        agentName: agent.name,
        source: 'scheduled',
        userText: triggerText,
      },
      handle.events,
      systemContext,
    );
    return await consumeRun(events, abortController);
  } finally {
    finalizeConversationBudget(runConvId); // 一次性会话用完即弃
  }
}

/**
 * 到点注入给模型的结构化触发 block（S18 迁自旧 deliver）。修「被当成新需求反问」的 bug：频率作为已知
 * 事实给出 → 模型知道日程早定好、不再每次追问；处置指令只拦「重新确认日程」、不拦正常发问。当前时间由
 * 执行体 systemContext 的 [运行时上下文] 段统一给（见 runScheduledConversation），此处只给频率/原定时刻。
 */
export function renderTriggerEvent(
  task: Pick<ScheduledTask, 'title' | 'prompt' | 'spec' | 'stopAfterRuns' | 'missedAt'>,
  opt: { late: boolean; dueAt?: number },
  fmtDue: (at: number) => string,
  /** D4 回落语言：本对话无更早用户消息、且上面指令语言中性时，产出回落界面语言（owner 的有效语言）。 */
  lang: 'zh' | 'en',
): string {
  // scaffolding 用英文（类③工程指令）——中文 scaffolding 会把产出往中文拽、抵消回落行。
  // task.title/prompt 是用户数据原样保留（它们才是真实语言信号）。
  const lines = [
    '<scheduled-task-trigger>',
    `Task: ${task.title}`,
    `Instruction: ${task.prompt}`,
    `Frequency: ${describeFrequency(task.spec, task.stopAfterRuns, tFor(lang))}`,
  ];
  if (opt.late) {
    lines.push(`Catch-up: missed at ${fmtDue(opt.dueAt ?? task.missedAt ?? Date.now())}, running now`);
  }
  lines.push('</scheduled-task-trigger>');
  lines.push(
    'The schedule is already set — no need to reconfirm the frequency or timing; just carry out this instruction. If something is genuinely ambiguous while doing it, ask as usual.',
  );
  lines.push(
    `(If this conversation has no earlier user message and the instruction above is language-neutral, write your reply in ${lang === 'zh' ? 'Chinese' : 'English'}.)`,
  );
  return lines.join('\n');
}

/** 迟到话术里的原定时刻格式化（自然语言，如「7月11日 08:00」）——按 owner 有效语言选 locale，与触发文本一致。 */
function fmtDueAt(at: number, lang: 'zh' | 'en'): string {
  return new Date(at).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── 生产 ExecutorDeps 装配（index.ts 调用）────────────────────────────
/**
 * 承载对话解析（归档判定迁入执行体，S11 规则原样带过）：runLocation=conversation 且对话存在且未归档
 * → 用它；channel → 复用该渠道活跃对话，归档/无则新建并绑定来源（getOrCreateConversation，从不解档）；
 * 两者未命中或 newConversation → 当场新建承载。
 */
export async function resolveCarrierConversation(
  task: ScheduledTask,
): Promise<{ agentId: string; conversationId: string }> {
  const { activeId } = await listAgents();
  if (!activeId) {
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    throw new Error(t('main:scheduled.noActiveAgent', lang));
  }
  const agentId = activeId;
  if (task.runLocation.kind === 'conversation') {
    try {
      const conv = await getConversation(agentId, task.runLocation.id);
      if (conv.archivedAt == null) return { agentId, conversationId: conv.id };
      // 已归档：不翻出，落到新对话承载（S11 · G101 / channels「从不解档」）
    } catch {
      // 已删：降级新建
    }
  } else if (task.runLocation.kind === 'channel') {
    // 渠道落点（G42）：复用该渠道用户的活跃对话；已归档 / 从无 → 新建一段并绑定来源（成为新的
    // 活跃对话，不解档旧段——正是「每个渠道用户一个活跃对话，归档就新建」）。
    const { platform, chatId } = task.runLocation;
    const conv = await getOrCreateConversation(agentId, { platform, chatId }, task.title || '定时任务');
    return { agentId, conversationId: conv.id };
  }
  const created = await createSubConversation(agentId, task.title || '定时任务');
  return { agentId, conversationId: created.id };
}

/** 承载对话是否仍可承载（未删且未归档）——结果落盘前重验（执行期间可能被删/被归档）。 */
async function isConversationUsable(agentId: string, conversationId: string): Promise<boolean> {
  try {
    const conv = await getConversation(agentId, conversationId);
    return conv.archivedAt == null;
  } catch {
    return false;
  }
}

export function makeScheduledExecutorDeps(broadcast: Broadcast): ExecutorDeps {
  return {
    now: () => Date.now(),
    getTask: getScheduledTask,
    settleRun: storeSettleRun,
    discardFires: storeDiscardFires,
    clearMissed: async (id) => {
      await patchScheduledTask(id, { missedAt: undefined });
    },
    resolveConversation: resolveCarrierConversation,
    ensureLandable: async (agentId, conversationId, task) => {
      // 落盘前重验；不可用则重解析承载（归档不翻出、不解档）。在结算前敲定，供结算与落盘共用。
      if (await isConversationUsable(agentId, conversationId)) return { agentId, conversationId };
      return resolveCarrierConversation(task);
    },
    readSnapshot: readHistoryForLLM,
    runConversation: (p) => runScheduledConversation(p, broadcast),
    broadcastStarted: ({ conversationId, taskId, title }) =>
      broadcast({ type: 'scheduledRun.started', conversationId, taskId, title }),
    landResult: async ({ agentId, conversationId, task, result }) => {
      // conversationId 已由 ensureLandable 敲定可用，直接落盘（不再自行重解析）。
      const landAgentId = agentId;
      const landConvId = conversationId;
      const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
      const card: ChatMessage = {
        id: newMessageId(),
        conversationId: landConvId,
        role: 'system',
        text: t(
          result.status === 'ok' ? 'main:scheduled.runCard.ok' : 'main:scheduled.runCard.error',
          lang,
          { title: task.title },
        ),
        toolCalls: [],
        createdAt: Date.now(),
        done: true,
        kind: 'scheduled-run',
        scheduledRun: { taskId: task.id, title: task.title, status: result.status },
      };
      await appendConvMessage(landAgentId, landConvId, card);
      // 成功且产出非空 → 紧跟一条产出消息（执行体最终文字原文即成品，正常 Oru 气泡；kind 只标来源供旁白扫描）
      let output: ChatMessage | undefined;
      if (result.status === 'ok' && result.text.trim().length > 0) {
        output = {
          id: newMessageId(),
          conversationId: landConvId,
          role: 'assistant',
          text: result.text,
          toolCalls: [],
          createdAt: Date.now(),
          done: true,
          kind: 'scheduled-run-output',
        };
        await appendConvMessage(landAgentId, landConvId, output);
      }
      // 列表/通知同步（承重）：appendMessage 只刷磁盘 updatedAt，前端 conversationStore 全靠
      // conv.state 广播刷新——不推则「updatedAt > lastSeenAt」判不出未读，完成通知 / 列表黄点 /
      // 新建承载对话的浮现全部缺席（定时任务跑完右上角无通知的根因，2026-07-30）。
      await pushConvState(landAgentId, null, null, broadcast);
      broadcast({ type: 'scheduledRun.finished', conversationId: landConvId, taskId: task.id, card, output });
      // 渠道落点（G42）：产出已落承载对话，再推送到该渠道聊天（脱敏 + 失败留痕在送达内核内做）。
      // 只推成功且非空的产出；失败/空产出只留在对话里，不往渠道发噪声。
      if (
        task.runLocation.kind === 'channel' &&
        result.status === 'ok' &&
        result.text.trim().length > 0
      ) {
        const { platform, chatId } = task.runLocation;
        const pushed = await deliverToChannel({ platform, chatId }, result.text).catch(
          (e): { ok: false } => {
            console.warn('[scheduledTasks] 渠道落点推送失败', e);
            return { ok: false };
          },
        );
        // 推送失败不再只埋进日志：在承载对话里留一条可见系统提示，让用户知道"结果没发到渠道、只在这"。
        if (!pushed.ok) {
          await appendConvMessage(landAgentId, landConvId, {
            id: newMessageId(),
            conversationId: landConvId,
            role: 'system',
            text: t('main:scheduled.channelPushFailed', lang, { title: task.title }),
            toolCalls: [],
            createdAt: Date.now(),
            done: true,
            kind: 'scheduled-run',
          });
        }
      }
    },
  };
}
