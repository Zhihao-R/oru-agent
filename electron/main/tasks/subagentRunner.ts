/**
 * TaskRunner：派工执行子 agent
 *
 * 流程（v2）：
 * 1. 收到 ActionProposal
 * 2. 在 target project 记 git baseline + 打 git tag oru/baseline-<taskId>
 * 3. ensureFeatureBranch（PRD F4：改动开 oru/<slug>，避免直接动 main）
 * 4. 起独立 SDK query：cwd=项目路径, ExecutorProfile + Twin 人格摘要 + 主对话最近上下文
 *    - 子 agent 挂 ask_twin / report_progress 工具
 *    - ask_twin 走 askTwinBridge → background Twin → 可能 escalate 给用户
 * 5. 流式输出走 task.progress 推到 UI（不进主对话）
 * 6. 任意终态（done/failed/cancelled）：
 *    - 计算 affectedPaths（git diff baselineTag..HEAD --name-only）
 *    - 打 oru/end-<taskId> tag
 *    - 写入 task store
 * 7. 完成 → 主对话写"回报卡片"（kind='task-report'）+ broadcast task.done
 *    失败 → 也写"❌ 任务失败"卡片 + broadcast task.failed
 *
 * cancel/rollback 通过模块导出的函数；router 收到请求后调用
 */
import type { ServerEventPayload } from '@shared/protocol';
import type { ActionProposal, CodeActionProposal, ChatMessage, SubagentTask } from '@shared/types';
import { ErrorCodes } from '@shared/types';
import { newMessageId, newTaskId, slugify } from '@shared/ids';
import { getAgent } from '../agent/store/agents';
import { getProject, getSettings } from '../projects/store';
import { getBackendFor, resolveThinkingDisable } from '../agent/backends';
import { singleUserTurn } from '../agent/singleUserTurn';
import { finalizeConversationBudget } from '../search/budget';
import {
  appendMessage as appendConvMessage,
  readHistoryForLLM,
} from '../conversations/store';
import { ensureFeatureBranch } from '../git/workflow';
import { recordBaseline, recordEndTag, computeAffectedPaths, type Baseline } from './git';
import { getProfile, PROJECT_CODER } from './profiles';
import { surfaceProposal, cancelSubagentProposals } from '../proposals/registry';
import { provisionAgent } from '../agent/capabilities';
import { createTask, updateTaskStatus, getTask } from './store';
import { pipeSdkToEventsForTask } from './stream';
import { instrumentConversation } from '../debug/instrument';
import { askTwin, abortPendingAnswers } from './askTwinBridge';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { readFile } from 'node:fs/promises';
import { deckIndexPath } from '../deck/pathResolver';
import { validateDeck, type DeckValidationError } from '../deck/validateDeck';
import { buildAdvisePrompt, fixProgressText, residualNote } from '../deck/deckFixPrompts';
import { DECK_REVIEW_GUARD_PROMPT } from '../prompts/deckReviewGuard';
import { acquire as keepAwakeAcquire, release as keepAwakeRelease } from '../keepAwake';

// 运行中任务登记：taskId → 中止句柄 + 派出它的主对话 id（对话级刹车按后者反查）+ 最近活动时刻（停滞看门狗依据）
const activeTasks = new Map<
  string,
  {
    ac: AbortController;
    conversationId: string;
    lastActivityAt: number;
    /** deck 任务：artifactId，供 deckTaskState 资源级去重查询（仅 deck 派工登记）。 */
    deckArtifactId?: string;
  }
>();
// 对话级刹车打标：runTask 的 catch 据此区分「刹车取消」（静默，不写对话内报告卡；PM 拍板
// 按停后不列被中断明细）与其余失败 / 手动 task.cancel（失败卡照写）。runTask finally 清标。
const brakeCancelled = new Set<string>();
// 停滞看门狗打标（G107）：看门狗判「长时间无活动」而中止的任务，catch 据此落 failed（超时失败，
// 非用户取消）并照写失败卡——与 brakeCancelled 的静默取消区分。
const stalledTasks = new Set<string>();
const baselines = new Map<string, Baseline>();

// 子任务停滞看门狗（G107·与后台命令同口径）：不定「最长跑多久」，只判「长时间没有任何新活动」
// （流式事件 / 工具调用都算活动）。等主对话答疑 / 等用户（awaiting_twin/awaiting_user）是合法阻塞、
// 不算停滞，看门狗按持久状态豁免。挂死（无事件无退出且不在等答）的子任务才被终止、判超时失败。
const SUBAGENT_STALL_MS = 30 * 60 * 1000;
const SUBAGENT_WATCHDOG_TICK_MS = 60 * 1000;
let subagentWatchdogTimer: ReturnType<typeof setInterval> | null = null;

function ensureSubagentWatchdog(): void {
  if (subagentWatchdogTimer) return;
  subagentWatchdogTimer = setInterval(() => void subagentWatchdogTick(), SUBAGENT_WATCHDOG_TICK_MS);
  subagentWatchdogTimer.unref?.();
}

function maybeStopSubagentWatchdog(): void {
  if (subagentWatchdogTimer && activeTasks.size === 0) {
    clearInterval(subagentWatchdogTimer);
    subagentWatchdogTimer = null;
  }
}

/** 是否有任意后台 subagent 任务在跑——keepAwake 合并判定读它（任一任务在跑即顶住）。 */
export function isAnyTaskRunning(): boolean {
  return activeTasks.size > 0;
}

/**
 * deck 生成去重（资源级：同 index.html 并发写是真冲突，不属去串行范畴）：查 activeTasks 里该 deck
 * 是否已有生成任务在跑（含启动段——启动段任务已在 activeTasks，天然覆盖）。仅 deck 派工登记
 * deckArtifactId，普通 code 任务查不到。去串行后无「排队」，只返回 running | null。
 */
export function deckTaskState(artifactId: string): 'running' | null {
  for (const entry of activeTasks.values()) {
    if (entry.deckArtifactId === artifactId) return 'running';
  }
  return null;
}

/** 仅测试用：清空 activeTasks 登记（含测试注入的假任务），防跨用例残留污染 size/keepAwake 判定。 */
export function __resetActiveTasksForTest(): void {
  activeTasks.clear();
}

/** 仅测试用：注入一个假的运行中任务，验停滞看门狗。返回其 AbortController。 */
export function __injectActiveTaskForTest(
  taskId: string,
  conversationId: string,
  lastActivityAt: number,
  deckArtifactId?: string,
): AbortController {
  const ac = new AbortController();
  activeTasks.set(taskId, { ac, conversationId, lastActivityAt, deckArtifactId });
  return ac;
}

/** 仅测试用：直接驱动一次看门狗扫描。 */
export function __subagentWatchdogTickForTest(): Promise<void> {
  return subagentWatchdogTick();
}

/** 仅测试用：某任务是否已被判停滞。 */
export function __isStalledForTest(taskId: string): boolean {
  return stalledTasks.has(taskId);
}

async function subagentWatchdogTick(): Promise<void> {
  const now = Date.now();
  for (const [taskId, entry] of [...activeTasks.entries()]) {
    if (now - entry.lastActivityAt < SUBAGENT_STALL_MS) continue;
    if (stalledTasks.has(taskId)) continue; // 已判停滞、abort 在途
    // 等答疑 / 等用户是合法阻塞（此间本就无事件），按持久状态豁免——不误杀正在等回答的子任务。
    const t = await getTask(taskId).catch(() => null);
    // await 后重检（铁律）：getTask 让出过 event loop，任务可能在此期间自然完成、runTask finally
    // 已 delete 了 activeTasks/stalledTasks 登记——此时再打标会往 stalledTasks 塞永不清理的幽灵 id。
    if (!activeTasks.has(taskId)) continue;
    if (t && (t.status === 'awaiting_twin' || t.status === 'awaiting_user')) {
      entry.lastActivityAt = now; // 重置计时，避免答复回来后立刻又被判停滞
      continue;
    }
    stalledTasks.add(taskId); // 先打标再 abort：runTask 的 catch 据此落 failed（超时）
    entry.ac.abort();
  }
}

/** 模型一直在改却不收敛（打地鼠）时的轮数硬上限兜底（PRD 决策五）。死数，兜得住不收敛。 */
const MAX_FIX_ROUNDS = 3;


/**
 * Deck 收尾建议式回路 = 校验→建议式回喊的循环（PRD 决策一/五）。**格式无关的骨架**：validate /
 * readDeck / 回喊消息都由调用方注入，函数内不 import 联系表/slide/deck 概念——任务 10b 的通用复查
 * 能复用这套，传它自己的依赖即可（任务 6 验收 7「骨架不焊死 deck 概念」）。
 *
 * 早停信号是"**deck 内容这轮没变**"而非"发现签名没变"（review 揪出的诚实性）：发现签名测不出
 * "改了被报页但没改干净"（如把溢出从 200px 压到 80px，签名仍在），会把"正在努力修"误判成"决定
 * 保留"并据此对用户撒谎。改用 deck 内容是否变化：模型动了 deck = 它在改 → 再给一轮；这轮一字没动
 * = 它停手了 → 收工、残留中性标注。第一次见到发现一定回喂（rounds===0 不触发早停），保证"模型至少
 * 被回喂一次"的硬保证（堵闭眼交付）；模型一直改却不收敛撞 maxRounds 兜底。
 *
 * 首轮生成在调用方做（这里只跑"校验后的回喊轮"）。abort 时 runConversation 内是 throw 不是
 * resolve——本函数不 catch，让异常透传到 runTask 外层取消路径（实现要害：包裹会吞掉取消）。
 */
export type FixLoopDeps<R> = {
  maxRounds: number;
  /** 客观校验：返回非空 = 还有客观项。 */
  validate: () => Promise<DeckValidationError[]>;
  /** 读当前 deck 内容（字符串比对早停信号；模型这轮改没改 deck 看它）。 */
  readDeck: () => Promise<string>;
  /** 跑一轮会话（回喊一条新消息，全新会话非续接）。abort 时 throw。 */
  runConversation: (userMessage: string) => Promise<R>;
  /** 回喊轮：发进度 + 返回建议式回喊消息。 */
  onAdvise: (round: number, errors: DeckValidationError[]) => string;
};
export type FixLoopOutcome<R> = {
  /** 跑过回喊轮时 = 最后一轮 result；没跑过则 undefined（调用方保留首轮 result）。 */
  result?: R;
  /** 收工时仍残留的客观项（模型停手 / 撞上限）；全绿则 null。 */
  residual: DeckValidationError[] | null;
  /** 实际跑了几轮回喊（不含首轮生成）。 */
  rounds: number;
};

export async function runFixLoop<R>(deps: FixLoopDeps<R>): Promise<FixLoopOutcome<R>> {
  let rounds = 0;
  let result: R | undefined;
  let prevHtml = await deps.readDeck(); // 首轮生成之后、第一次回喂之前的 deck 内容（基线）
  while (true) {
    const errors = await deps.validate();
    if (errors.length === 0) return { result, residual: null, rounds }; // 干净，收工
    const curHtml = await deps.readDeck();
    // 上一轮回喂后模型没动 deck = 它停手了（决定保留 / 认为修不了）→ 收工、残留中性标注。
    // rounds===0 时不触发：保证"模型至少被回喂一次"的硬保证（堵闭眼交付）。
    if (rounds > 0 && curHtml === prevHtml) return { result, residual: errors, rounds };
    if (rounds >= deps.maxRounds) return { result, residual: errors, rounds }; // 打地鼠不收敛兜底
    prevHtml = curHtml;
    rounds += 1;
    result = await deps.runConversation(deps.onAdvise(rounds, errors)); // 建议式回喊
  }
}

type RunArgs = {
  agentId: string;
  proposal: CodeActionProposal;
  emit: (ev: ServerEventPayload) => void;
};

export async function runTask({ agentId, proposal, emit: rawEmit }: RunArgs): Promise<void> {
  const profileId = proposal.profileId ?? PROJECT_CODER.id;
  const profile = getProfile(profileId) ?? PROJECT_CODER;
  const taskId = newTaskId();

  // 包一层 emit：任何往 UI 推的事件（流式文本 / 工具调用 / 进度）都算「有活动」，刷新停滞看门狗计时。
  const emit = (ev: ServerEventPayload): void => {
    const entry = activeTasks.get(taskId);
    if (entry) entry.lastActivityAt = Date.now();
    rawEmit(ev);
  };

  // 对话级刹车登记先于首个 await：任务出队（shift）后若登记晚于启动段（backend 检查 /
  // git 子进程 / provisionAgent，可达秒级），窗口内任务既不在队列也不在 activeTasks——
  // 双撤销抓空、任务静默逃逸照常跑完。AbortController 随任务诞生即存在；启动段自身
  // 不监听信号，起跑前再重检一次 signal.aborted（见首轮 runConversationOnce 之前）。
  const ac = new AbortController();
  activeTasks.set(taskId, {
    ac,
    conversationId: proposal.conversationId,
    lastActivityAt: Date.now(),
    deckArtifactId: proposal.deckContext?.artifactId,
  });
  // keepAwake：任务一登记即算「在干活」——顶住休眠。release 只挂在 runTask finally（每任务恰一次），
  // 不挂 activeTasks.delete 散点（cancelTask + finally 双删会双扣计数，见技术设计 §4.2 警告）。
  keepAwakeAcquire();
  ensureSubagentWatchdog();

  const task: SubagentTask = {
    id: taskId,
    ownerId: getCurrentOwnerId(),
    agentId,
    conversationId: proposal.conversationId,
    proposalId: proposal.id,
    proposalTitle: proposal.title,
    targetProjectId: proposal.targetProjectId,
    status: 'pending',
    baselineCommit: null,
    summary: null,
    errorMessage: null,
    startedAt: Date.now(),
    finishedAt: null,
    profileId: profile.id,
    endTag: null,
    affectedPaths: [],
    commitsCreated: [],
    announcedAt: null,
    featureBranch: null,
    // deck 生成任务的归属 artifact——UI 按它反查「该 deck 生成中/排队中」（走查二批该修 4）
    ...(proposal.deckContext ? { deckArtifactId: proposal.deckContext.artifactId } : {}),
  };
  // cwd 在 try 内解析出 agent 后立即赋值；getAgent 之前失败时 baseline 恒 no-repo，
  // catch 的 computeFinishMeta 不会用到这个占位值。
  let cwd = '';
  let baseline: Baseline = { kind: 'no-repo' };

  try {
    // getAgent / createTask 也在 try 内：它们失败同样要走 finally 清 activeTasks 登记
    // ——登记已提前到函数开头，任何提前退出都不能留下孤儿句柄。
    const agent = await getAgent(agentId);
    cwd = agent.homePath;
    await createTask(task);
    emit({ type: 'task.started', task });

    // D3：backend 解析 + 守卫 + env 准备提前到 git 操作之前，确保被拒任务零 git 副作用。
    // 背景：proposeAction 创建提案与 runTask 执行之间用户可能切换模型分配；此处重检确保
    // 「提案创建时 anthropic → 用户切 OpenRouter → 确认 → runTask 解析到非 anthropic」
    // 这条并发路径被守住，不会在 git 操作之后才失败（撞「await 后重检共享状态」铁律）。
    const backend = await getBackendFor('subagentCoder');
    const ready = await backend.isReady();
    if (!ready.ok) {
      const err = new Error(ready.hint) as Error & { code?: string };
      err.code = ErrorCodes.AGENT_NO_AUTH;
      throw err;
    }
    // subagentCoder 思考三态（Track B）：干活主力默认开思考；模型不支持则 undefined（后端缺省压掉）。
    const subagentDisableReasoning = resolveThinkingDisable('subagentCoder', await getSettings());
    if (proposal.targetProjectId) {
      const p = await getProject(proposal.targetProjectId);
      cwd = p.path;
      baseline = await recordBaseline(p.path, taskId);
      baselines.set(taskId, baseline);
      const baselineCommit = baseline.kind === 'commit' ? baseline.commit : null;

      // PRD F4：派工时切到 feature 分支（如果当前在保护分支会新建 oru/<slug>）
      let featureBranch: string | null = null;
      try {
        featureBranch = await ensureFeatureBranch(p.path, slugify(proposal.title));
      } catch (e) {
        // 分支切换失败不阻断（可能是只读 / 无 .git；已在 baseline 阶段处理过）
        // eslint-disable-next-line no-console
        console.warn(`[task ${taskId}] ensureFeatureBranch failed:`, e);
      }
      await updateTaskStatus(taskId, 'running', { baselineCommit, featureBranch });
    } else {
      await updateTaskStatus(taskId, 'running');
    }
    // running 转换必须广播：task.started 带的是 createTask 时的 pending 快照，渲染层
    // taskStore 只在 statusChanged 上改 status。漏掉这条，卡片徽标会一路停在「准备中」
    // 直到 done/failed 才跳走（done/cancelled/failed 都配了广播，唯独首次转 running 漏了）。
    emit({ type: 'task.statusChanged', taskId, status: 'running' });

    // 声明式能力 · 阶段二（usage=subagentCoder）：联网引导 + 目标项目 CLAUDE.md（修分叉 1）+
    // 预算桶 reset（task_<taskId> 一次性桶）+ 禁 SDK 内置 WebSearch/WebFetch。
    // subagentCoder 此前手拼 prompt、从不调 loadProjectClaudeMdSection——在用户项目里写代码却看不到项目规范。
    const provision = await provisionAgent({
      usage: 'subagentCoder',
      searchBudgetId: `task_${taskId}`,
      activeProjectId: proposal.targetProjectId,
    });

    // 拼 systemPrompt：profile + 主分身人格 + 主对话最近上下文 + 能力供给（联网引导 + CLAUDE.md）
    const recentCtx = await buildRecentContextSummary(agentId, proposal.conversationId);
    const personaHint = `## 你是从 Twin 派出的子 agent\n你的"父分身"叫 ${agent.name}。`;
    const segments: string[] = [
      profile.systemPromptAppend,
      personaHint,
      `## 主对话最近上下文\n${recentCtx}`,
      provision.capabilityPrompt,
      // 收尾守卫提示词仅 deck 任务注入（决策 3：不进 capabilityPrompt，避免灌到非 deck 编码任务）
      proposal.deckContext ? DECK_REVIEW_GUARD_PROMPT : '',
    ];
    const systemAppend = segments.filter((s) => s.length > 0).join('\n\n');

    // 后台 subagent 执行命令撞到要审批的（破坏性 / 未授权）→ 把审批卡回流到派出它的主对话（B 块）。
    // 借鉴 subagentChat 的 wrappedOnProposal：注入 triggeredBySubagent + 改写 conversationId 为主对话 id
    // ——执行期新生成的 bash proposal 其 conversationId=task_${taskId}（前端按它路由找不到对话），主对话 id
    // 现成可得 = 派工 proposal.conversationId（取自主对话 ctx）。回调抛错只记日志、不 abort 整个 subagent
    // （审批基础设施失败 ≠ 任务失败）。rememberProposal 让 router.proposal.execute/reject 能按 id 找到并 settle。
    const mainConversationId = proposal.conversationId;
    const onSubagentProposal = async (p: ActionProposal): Promise<void> => {
      const routed: ActionProposal = {
        ...p,
        conversationId: mainConversationId,
        triggeredBySubagent: { taskId, description: proposal.title },
      };
      try {
        // surface 一张审批卡的单一入口（与主对话 onProposal 共用）：登记进 proposals Map + 广播 chat.proposal。
        // 「挂起可见入口 / 未读计数」纯前端从 proposalsByConv 派生（数该对话的待批卡，C 块），后端不维护任务态——
        // 数卡不数任务才正确：同一任务并发多张卡时，批一张只递减一张、其它仍待批（任务态做不到这点）。
        surfaceProposal(routed, emit);
      } catch (e) {
        console.warn(`[task ${taskId}] 审批卡回流主对话失败（不影响任务执行）:`, e);
      }
    };

    // 子 agent 工具（ask_twin / report_progress）通过 ToolContext 携带闭包传给 AgentTool。
    // 每轮 fix 重喊一条新消息（全新会话、非续接旧会话），其余入参恒定——抽成 runConversationOnce。
    const runConversationOnce = (userMessage: string) => {
      const handle = backend.runConversation({
        agentId: task.agentId,
        conversationId: `task_${taskId}`,
        userMessage,
        // 子 agent 不消费既有 history，但 userMessage 必须作为 history 末尾 user 轮：非
        // claudeCode 后端只读 history、不读 userMessage（见 singleUserTurn 注释）
        history: singleUserTurn(`task_${taskId}`, userMessage),
        systemContext: systemAppend,
        cwd,
        abortController: ac, // 复用同一 ac：用户中途取消，正在改的那轮立刻停（决策 5.2）
        allowedTools: profile.allowedTools,
        // 能力供给的 extraDisallowed（联网：禁 SDK 内置 WebSearch/WebFetch）合入 profile 黑名单
        disallowedTools: [...(profile.disallowedTools ?? []), ...provision.extraDisallowed],
        toolContext: {
          // 能力供给的 ToolContext patch（联网：searchBudgetId=task_<taskId>，与本桶一致）
          ...provision.toolContextPatch,
          conversationId: `task_${taskId}`,
          agentId,
          ownerId: getCurrentOwnerId(),
          usage: 'subagentCoder',
          // 挡位实时继承派出它的分身（B 块）：emitProposal 实时 getAgent(agentId)，中途切只读立即生效。
          // 此字段不作判定来源——agent 存在时恒被实时值覆盖，只在 agent 已被删的死角才回落到这个启动快照。
          approvalMode: agent.approvalMode,
          // bash 命令的工作目录 = 任务项目根（与改文件同处）；defaultSearchRoot 据此解析，无项目时回落 agent 家目录。
          activeProjectId: proposal.targetProjectId ?? undefined,
          abortSignal: ac.signal,
          // 命令撞到审批 → 卡片回流主对话（破坏性命令弹卡；非破坏性/只读命令在 emitProposal 直接放行不经此）
          onProposal: onSubagentProposal,
          taskId,
          // deck 任务：把 deck 路径塞进 toolContext，render_contact_sheet / view_slide 据此取页
          deckPath: proposal.deckContext?.deckPath,
          askTwinResolver: (_taskId, question, contextPaths) =>
            askTwin({
              agentId,
              taskId,
              question,
              contextPaths,
              emit,
              maxAskTwin: profile.maxAskTwin,
            }),
          progressEmit: (text) =>
            emit({ type: 'task.progress', progress: { taskId, text, source: 'speech' } }),
        },
        // 思考三态（Track B）：subagentCoder 默认开思考（干活主力），走中央判据在 runTask 入口算一次。
        disableReasoning: subagentDisableReasoning,
      });
      const events = instrumentConversation(
        backend,
        {
          roundId: newMessageId(),
          conversationId: `task_${taskId}`,
          ownerId: getCurrentOwnerId(),
          agentId,
          agentName: agent.name,
          source: 'taskboard',
          userText: userMessage,
        },
        handle.events,
        systemAppend,
      );
      return pipeSdkToEventsForTask(events, { taskId, emit });
    };

    // 起跑前重检（await 后重检共享状态）：启动段的一长串 await 不监听 abort 信号，
    // 对话级刹车若落在这段盲窗，任务必须被截在起跑线上、不得开启 backend 会话。
    if (ac.signal.aborted) throw new Error('任务在启动阶段被用户取消');

    // 首轮：生成（或编辑）。三件收工事（回报卡/预览/done）留在循环外、天然只发一次（决策 5.1）。
    let result = await runConversationOnce(proposal.rawPlan);
    let residual: DeckValidationError[] | null = null;

    // 建议式收尾回路：仅 deck 任务跑校验循环（决策 5.3）；非 deck 任务一趟即收、零变化。
    if (proposal.deckContext) {
      const deckPath = proposal.deckContext.deckPath;
      const outcome = await runFixLoop({
        maxRounds: MAX_FIX_ROUNDS,
        validate: () => validateDeck(deckPath, ac.signal), // stub 时恒空 → 循环零额外轮次 = 同现状（决策 5.4）；signal 让取消能中止逐页渲染
        // 读失败兜成 ''（不 throw）：保住"让模型有机会修复缺失/坏 index.html"这条路径（'' 与真实
        // 非空内容必不相等 → validate 报的 structure 会被回喂）。代价是极罕见的连续两次读失败会把
        // 残留误判成"模型停手"——但本地同进程刚写过的文件几乎不会读失败，且残留标注本就中性、不撒谎。
        readDeck: () => readFile(deckIndexPath(deckPath), 'utf-8').catch(() => ''),
        runConversation: runConversationOnce,
        onAdvise: (round, errors) => {
          emit({ type: 'task.progress', progress: { taskId, text: fixProgressText(round, errors) } });
          return buildAdvisePrompt(errors, proposal.rawPlan);
        },
      });
      if (outcome.result) result = outcome.result; // 用最后一轮 result（含模型最后回应的 summary）
      residual = outcome.residual;
    }

    // 算 affectedPaths + mixedDirty + 打 endTag（仅在有 git 项目时有意义）
    const finishMeta = await computeFinishMeta(taskId, cwd, baseline, proposal.targetProjectId);

    // 完成回报写入主对话（kind='task-report'）；mixedDirty 非空时追加 warn 段。
    // 模型停手 / 撞上限后仍残留的客观项：body 追加一条中性标注（PRD 决策五，不臆断是有意保留还是未及修复）。
    const reportBody = result.summary || '(子 agent 没有给出文字回报)';
    const reportText = composeReportText({
      kind: 'ok',
      title: proposal.title,
      body: residual ? `${reportBody}\n\n${residualNote(residual)}` : reportBody,
      mixedDirtyPaths: finishMeta.mixedDirtyPaths,
    });
    const reportMsg: ChatMessage = {
      id: newMessageId(),
      conversationId: proposal.conversationId,
      role: 'assistant',
      text: reportText,
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
      kind: 'task-report',
      refId: taskId,
    };
    await appendConvMessage(agentId, proposal.conversationId, reportMsg);
    emit({
      type: 'chat.taskReport',
      conversationId: proposal.conversationId,
      taskId,
      message: reportMsg,
    });

    await updateTaskStatus(taskId, 'done', {
      summary: result.summary,
      finishedAt: Date.now(),
      affectedPaths: finishMeta.affectedPaths,
      endTag: finishMeta.endTag,
    });

    // deck 创建 subagent 写完 index.html → 通知前端刷新预览（hot reload）
    // 修改链路已交对话 LLM + artifact_finalize_submission 收尾，不再走子 agent 回执
    if (proposal.deckContext) {
      emit({ type: 'artifact.indexChanged', artifactId: proposal.deckContext.artifactId });
    }

    emit({ type: 'task.done', taskId, summary: result.summary });
    emit({ type: 'task.statusChanged', taskId, status: 'done' });
  } catch (e) {
    // 诊断日志：完整栈信息精确定位 trim 崩溃源（Issue #trim-undefined）
    console.error(`[runTask ${taskId}] 错误:`, e);
    const msg = e instanceof Error ? e.message : String(e);
    // 算 finishMeta 以拿到 mixedDirty 用于终态卡片
    const finishMeta = await computeFinishMeta(taskId, cwd, baseline, proposal.targetProjectId);
    // 用户主动取消（对话级刹车 或 手动 task.cancel）落 cancelled，而不是把「自己按停」显示成
    // 「失败」。判定依据 ac.signal.aborted 可靠：本 ac 只由 cancelTask / cancelTasksForConversation
    // 触发 abort，真实错误（backend 挂 / 工具炸）时 signal 未 aborted——据此区分「取消」与「失败」。
    // 停滞看门狗中止的（stalledTasks）：虽 ac.aborted，但语义是「超时失败」不是「用户取消」——
    // 落 failed、照写失败卡（页面「超时即判失败、回叙事流交主 agent 处置」）。
    const isStalled = stalledTasks.has(taskId);
    const isCancelled = ac.signal.aborted && !isStalled;
    const failMsg = isStalled ? '子任务长时间无响应，已判超时并终止（可重派或改换路径）' : msg;
    // 对话级刹车取消的任务不写对话内报告卡（PM 拍板：按停后不列被中断明细，面板终态
    // 足够）；手动 task.cancel、真实失败、停滞超时不进 brakeCancelled，终态卡照写让 Twin 能决策——
    // 取消写「已取消」卡、真错误/超时写「失败」卡。
    if (!brakeCancelled.has(taskId)) {
      try {
        const reportMsg: ChatMessage = {
          id: newMessageId(),
          conversationId: proposal.conversationId,
          role: 'assistant',
          text: composeReportText({
            kind: isCancelled ? 'cancelled' : 'failed',
            title: proposal.title,
            body: isCancelled ? '任务已取消。' : `任务失败：${failMsg}`,
            mixedDirtyPaths: finishMeta.mixedDirtyPaths,
          }),
          toolCalls: [],
          createdAt: Date.now(),
          done: true,
          kind: 'task-report',
          refId: taskId,
        };
        await appendConvMessage(agentId, proposal.conversationId, reportMsg);
        emit({
          type: 'chat.taskReport',
          conversationId: proposal.conversationId,
          taskId,
          message: reportMsg,
        });
      } catch (e) {
        // 终态回报本身写不进去也不要再抛——但要留痕，否则后续排障无线索
        console.warn(`[task ${taskId}] 终态回报写入失败，已忽略:`, e);
      }
    }
    // cancelled 不是错误：errorMessage 置空（取消无「错误信息」可言）。停滞超时算 failed、带超时错因。
    await updateTaskStatus(taskId, isCancelled ? 'cancelled' : 'failed', {
      errorMessage: isCancelled ? null : failMsg,
      finishedAt: Date.now(),
      affectedPaths: finishMeta.affectedPaths,
      endTag: finishMeta.endTag,
    });
    // 取消走 task.statusChanged=cancelled（与 rollback 的 rolled_back 同一呈现通道）；真错误/超时
    // 才广播 task.failed（触发前端 markFailed / 报错呈现）。
    if (isCancelled) {
      emit({ type: 'task.statusChanged', taskId, status: 'cancelled' });
    } else {
      emit({ type: 'task.failed', taskId, errorMessage: failMsg });
      emit({ type: 'task.statusChanged', taskId, status: 'failed' });
    }
  } finally {
    activeTasks.delete(taskId);
    keepAwakeRelease(); // 与登记处 keepAwakeAcquire 恰好一对：每任务恰释放一次（见 §4.2 警告）
    brakeCancelled.delete(taskId);
    stalledTasks.delete(taskId);
    maybeStopSubagentWatchdog();
    abortPendingAnswers(taskId, 'task ended; pending user answer aborted');
    // 任意终态（含 SDK 子进程异常崩、engine 抛错等非用户取消路径）都撤掉该任务悬在主对话的命令审批卡——
    // 否则那张 pending 卡 + 它的 waiter 永久泄漏、对话未读徽标减不掉。幂等（只 pending→rejected）：
    // 正常完成时无 pending 卡、零副作用；命令仍挂起等审批时崩了，这里兜住孤儿卡。
    cancelSubagentProposals(taskId, emit);
    // 一次性 task_${taskId} conversationId 用完即弃，删 budget Map entry 避免泄漏
    finalizeConversationBudget(`task_${taskId}`);
  }
}

type FinishMeta = {
  affectedPaths: string[];
  mixedDirtyPaths: string[];
  endTag: string | null;
};

async function computeFinishMeta(
  taskId: string,
  cwd: string,
  baseline: Baseline,
  targetProjectId: string | null,
): Promise<FinishMeta> {
  const empty: FinishMeta = { affectedPaths: [], mixedDirtyPaths: [], endTag: null };
  if (!targetProjectId || baseline.kind !== 'commit') return empty;
  const baselineRef = baseline.tag ?? baseline.commit;
  try {
    const result = await computeAffectedPaths(cwd, baselineRef, baseline.preExistingPaths);
    const endTag = await recordEndTag(cwd, taskId);
    if (result.mixedDirtyPaths.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[task ${taskId}] 检测到 mixedDirty 文件（用户预先改 + task 又改）：`,
        result.mixedDirtyPaths.join(', '),
      );
    }
    return { affectedPaths: result.affectedPaths, mixedDirtyPaths: result.mixedDirtyPaths, endTag };
  } catch (e) {
    console.warn(`[task ${taskId}] computeFinishMeta 失败，按 empty 处理:`, e);
    return empty;
  }
}

function composeReportText(args: {
  kind: 'ok' | 'failed' | 'cancelled';
  title: string;
  body: string;
  mixedDirtyPaths: string[];
}): string {
  // emoji 前缀只是文本装饰——前端 TaskReportCard 会剥掉它，按 task.status 重新派生图标/配色。
  const prefix = args.kind === 'ok' ? '✅' : args.kind === 'cancelled' ? '⛔' : '❌';
  const head = `${prefix} ${args.title}`;
  const sections = [head, '', args.body];
  if (args.mixedDirtyPaths.length > 0) {
    const list = args.mixedDirtyPaths.map((p) => `  - ${p}`).join('\n');
    sections.push(
      '',
      '⚠️ 以下文件在 task 启动前已经有过你的修改，task 期间又被改动：',
      list,
      '',
      '为避免误撤你已有的工作，rollback **不会**回退这些文件。如需精确撤回，请手动决定保留哪一版。',
    );
  }
  return sections.join('\n');
}

export function cancelTask(taskId: string): boolean {
  const entry = activeTasks.get(taskId);
  if (!entry) return false;
  entry.ac.abort(); // 前台命令子进程组经 ctx.abortSignal → runForeground 的 onAbort 立即杀（B 块）
  // 后台命令（run_in_background）进程脱离 ac 生命周期，按其 conversationId=task_${taskId} 登记，显式清：
  void import('../proposals/executeBashProposal').then(({ killBashForConversation }) =>
    killBashForConversation(`task_${taskId}`),
  );
  activeTasks.delete(taskId);
  abortPendingAnswers(taskId, 'task cancelled');
  return true;
}

/**
 * 对话级刹车（理想架构 subagent.html#PFail）：取消该对话派出的所有运行中任务，
 * 返回被取消的 taskId 供调用方做同款收尾（撤悬卡 / markAnnounced 抑制播报）。
 * 逐个复用 cancelTask 内核——abort 传导与 task 级后台 bash 清理不另写第二份。
 * 被刹任务走静默取消（brakeCancelled 打标）：不写对话内报告卡，面板终态照常。
 */
export function cancelTasksForConversation(conversationId: string): string[] {
  const taskIds = [...activeTasks.entries()]
    .filter(([, entry]) => entry.conversationId === conversationId)
    .map(([taskId]) => taskId);
  for (const taskId of taskIds) {
    brakeCancelled.add(taskId); // 先打标再 abort：runTask 的 catch 据此走静默
    cancelTask(taskId);
  }
  return taskIds;
}

async function buildRecentContextSummary(agentId: string, convId: string): Promise<string> {
  try {
    // 用 readHistoryForLLM 拿"marker 后视野"——避免 sub-agent 看到主对话里已被压缩的旧内容
    const all = await readHistoryForLLM(agentId, convId);
    // filter 掉 system kind 消息（marker 的通知文案对 sub-agent 是噪声）
    const dialog = all.filter((m) => m.role === 'user' || m.role === 'assistant');
    const recent = dialog.slice(-6);
    if (recent.length === 0) return '(主对话还没有历史)';
    return recent
      .map((m) => `[${m.role}] ${truncate(m.text ?? '', 400)}`)
      .join('\n\n');
  } catch {
    return '(无法读取主对话历史)';
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}
