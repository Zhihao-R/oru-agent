/**
 * 对话期 Subagent runner —— 主 agent 调 Task 工具时的执行体。
 *
 * 跟现有 `electron/main/tasks/subagentRunner.ts`（后台审批编码任务，含 propose/approve
 * /async exec/ask_twin 生命周期）**完全不同**——本文件是同步派遣 + 单次响应模型，
 * 没有反向通道，没有审批闸门（副作用工具仍走主对话现有审批路径）。
 *
 * 设计要点见 docs/tech/2026-05-25-conversational-subagent-tech-design.md。
 */
import type {
  AgentBackend,
  InheritedToolContext,
  StableSystemContext,
  ToolResult,
} from '@shared/agent/backend';
import type {
  ActionProposal,
  ApprovalMode,
  ChatMessage,
  SubagentChipRef,
} from '@shared/types';
import { newMessageId, newSubagentTaskId } from '@shared/ids';
import { appendSidecarMessage, ensureSidecarDir } from './sidecar';
import { stringifyToolResultContent } from '../toolResultText';
import { provisionAgent } from '../capabilities';
import { finalizeConversationBudget } from '../../search/budget';
import { toolObject, shorten } from '@shared/agent/toolActivity';
import { normalizeToolName } from '@shared/agent/toolName';
import { instrumentConversation } from '../../debug/instrument';
import { makeSubagentAskTwinResolver } from './askTwinResolver';

export type RunSubagentDeps = {
  /**
   * 主对话的 conversationId。subagent 的 toolContext.conversationId 也用这个值——
   * 不是 `${parent}/subagent/${taskId}` 这种子级 ID。
   *
   * 理由：subagent 调 Task(mode=async) 时 dispatchAsyncSubagent 用 ctx.conversationId
   * 拼 ActionProposal；前端按 conversationId 路由审批卡片。子级 ID 前端找不到
   * 对应 conversation，审批卡显示不出来。
   */
  conversationId: string;
  agentId: string;
  /** 父 agent 名——仅调试日志展示用（subagent 沿用父 agent 身份） */
  agentName: string;
  ownerId: string;
  backend: AgentBackend;
  /**
   * 主对话的稳定 system 前缀。Nominal type 保护——严禁传入完整 systemContext
   * （含 dynamic 段的当前时间）。
   */
  parentStableSystemContext: StableSystemContext;
  /** 主 agent 的工作目录（subagent 沿用） */
  cwd: string;
  activeProjectId?: string;
  /** 透传主对话审批挡位——subagent toolContext.approvalMode 跟主 agent 一致 */
  approvalMode: ApprovalMode;
  /** 主对话 abort signal——用户取消主对话时所有 subagent 一起 abort */
  abortSignal: AbortSignal;
  /**
   * 主对话 ToolContext 的「继承组」（字段与判据见 InheritedToolContext 定义）——subagent runner
   * 用 `...deps.inherited` 整组展开进 toolContext（onProposal 会再包一层注入 triggeredBySubagent）。
   * 收成一个字段是为了消灭三处手抄清单，漏传在结构上不可能。
   */
  inherited: InheritedToolContext;
  /** 实时广播 subagent chip 状态变化（不落盘；用于 spinner / 状态切换） */
  broadcastChip: (chip: ChatMessage) => void;
  /** 完成时落盘 chip 到主对话 jsonl + broadcast（最终态快照） */
  persistChip: (chip: ChatMessage) => Promise<void>;
};

const SUBAGENT_ROLE_SUFFIX =
  '\n\n---\n\n[Subagent 角色]\n' +
  '你是被主 agent 派出的 subagent。你看不到主对话历史，所有上下文已在 user message 里。' +
  '单次响应内完成给定任务，不能反问主对话。完成后直接给出最终结果。';

export async function runSubagent(
  req: { description: string; prompt: string },
  deps: RunSubagentDeps,
): Promise<ToolResult> {
  const taskId = newSubagentTaskId();
  const startedAt = Date.now();
  const chipMessageId = newMessageId();

  // chip 是摘要消息，不带 backendType/modelId 等 LLM 响应特有字段；
  // historyAdapter 也按 kind='subagent' 过滤掉，不喂回主 agent 上下文
  const buildChip = (ref: SubagentChipRef, text = '', done = false): ChatMessage => ({
    id: chipMessageId,
    conversationId: deps.conversationId,
    role: 'assistant',
    text,
    toolCalls: [],
    createdAt: startedAt,
    done,
    kind: 'subagent',
    subagent: ref,
  });

  const baseRef: SubagentChipRef = {
    taskId,
    description: req.description,
    status: 'running',
    prompt: req.prompt,
    startedAt,
  };

  deps.broadcastChip(buildChip(baseRef));

  // fork system：parentStableSystemContext 跟主对话**逐字一致**作为 stable 段
  // （主对话 cache 在 provider 端已用此 key 建立），SUBAGENT_ROLE_SUFFIX 作为 dynamic 段
  // 放在 stable 之后。这样：
  //   - subagent 第一次请求即命中主对话 stable 段的 cache（不是 cache miss 后才建自己的）
  //   - 后续每个 subagent 派遣共享同一 stable 段 cache
  //   - SUFFIX 作为 dynamic 不进 cache_control，每次重发不浪费（很短，常量）
  const parentStable = deps.parentStableSystemContext as string;

  // 声明式能力 · 阶段二（usage=twinSubagent）：
  // - 独立预算桶（与主对话 conversationId 区分），子 agent 搜得再多不吃主对话额度。
  // - 联网引导 prompt 叠在 SUFFIX 之后（dynamic 区，不并入 parentStable）——parentStable 已不含联网
  //   prompt（主对话已迁出），子 agent 自己 provision，无双注入；cache marker 仍是纯净的 parentStable。
  const searchBudgetId = `subagent_${taskId}`;
  const provision = await provisionAgent({
    usage: 'twinSubagent',
    searchBudgetId,
    activeProjectId: deps.activeProjectId ?? null,
  });
  const fullSystem =
    parentStable +
    SUBAGENT_ROLE_SUFFIX +
    (provision.capabilityPrompt ? '\n\n---\n\n' + provision.capabilityPrompt : '');

  // 派生 abort controller：parent abort 必导通
  const derivedAbort = new AbortController();
  const onParentAbort = (): void => derivedAbort.abort();
  if (deps.abortSignal.aborted) {
    derivedAbort.abort();
  } else {
    deps.abortSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  // 包装 onProposal：注入 triggeredBySubagent + 切 chip 状态
  // 注意：审批 callback 抛错不该 abort 整个 subagent（审批基础设施失败 ≠ subagent 任务失败），
  // 在包装内 catch 并记录，不冒泡。状态切回 running 只在成功时——失败时让 outer 流程接管。
  const wrappedOnProposal: ((p: ActionProposal) => Promise<void>) | undefined =
    deps.inherited.onProposal
      ? async (proposal: ActionProposal) => {
          const augmented = {
            ...proposal,
            triggeredBySubagent: { taskId, description: req.description },
          } as ActionProposal;
          deps.broadcastChip(buildChip({ ...baseRef, status: 'awaiting_approval' }));
          try {
            await deps.inherited.onProposal!(augmented);
            deps.broadcastChip(buildChip({ ...baseRef, status: 'running' }));
          } catch (e) {
            // 审批 callback 自身出错——记录但不让 subagent 整个失败（chip 保持 awaiting_approval，
            // 用户看得见哪个 proposal 卡住）。已知局限：吞错后调用方（如 proposeAction）感知不到失败，
            // 派发真失败时仍会乐观回执「已派工」；因触发极罕见（对话期 subagent 派工 × 派发恰好抛错，
            // 而此路径 onProposal 几乎全是同步入队、正常不抛）暂不根治。根治走「给 onProposal 加成败
            // 返回值让调用方自判」，别改成冒泡——emitProposal / plugin / mcp 等调用方未自包 catch，
            // 冒泡会把 subagent 整个搞崩。
            console.warn('[runSubagent] parent onProposal threw:', e);
          }
        }
      : undefined;

  // 留痕卡同等注入 triggeredBySubagent——否则对话期 subagent 装 MCP 时，卡上看不出是谁干的。
  // 不切 chip 状态：它不是审批请求，subagent 没在等任何人。
  const wrappedOnProposalTrace: ((p: ActionProposal) => Promise<void>) | undefined =
    deps.inherited.onProposalTrace
      ? async (proposal: ActionProposal) =>
          deps.inherited.onProposalTrace!({
            ...proposal,
            triggeredBySubagent: { taskId, description: req.description },
          } as ActionProposal)
      : undefined;

  // 单条完整 ChatMessage 作为 subagent 的初始 user message
  const subagentHistory: ChatMessage[] = [
    {
      id: newMessageId(),
      conversationId: deps.conversationId,
      role: 'user',
      text: req.prompt,
      toolCalls: [],
      createdAt: startedAt,
      done: true,
    },
  ];

  let finalText = '';
  let inputTok = 0;
  let outputTok = 0;
  let cacheRead = 0;
  let isError = false;
  let errorMessage: string | undefined;

  try {
    // 一次性 mkdir sidecar 目录；放在 try 内确保 mkdir 失败时走 catch + persistChip
    // 而非冒泡导致 chip 卡在 running 状态
    await ensureSidecarDir(deps.ownerId, deps.agentId, deps.conversationId);

    const handle = deps.backend.runConversation({
      agentId: deps.agentId,
      conversationId: deps.conversationId,
      userMessage: req.prompt,
      history: subagentHistory,
      systemContext: fullSystem,
      // 关键：stable 段传 parentStable（不含 SUFFIX）—— cache_control marker 打在
      // 主对话相同位置，subagent 第一次请求即命中主对话 cache
      stableSystemContext: parentStable,
      // 第二断点：SUFFIX + capabilityPrompt 是子 agent 会话期常量，作
      // sessionStable 让第二断点覆盖——P4/C2 迁进 capabilityPrompt 的内容（deck 路由 /
      // 项目 CLAUDE.md 可能数 KB）不再随子 agent 工具循环每轮全价重发。fullSystem 之后
      // 无动态尾部，直接整段作会话级稳定前缀，前缀不变量天然成立。
      sessionStableSystemContext: fullSystem,
      cwd: deps.cwd,
      abortController: derivedAbort,
      // subagent chat：用户在实时看 subagent 的输出 → 开逐 token 流式（同主对话）。
      streaming: true,
      // 嵌套保护：subagent 用主对话 backend 实例（backend 注入了 Task 工具），
      // 通过 disallowedTools 把 Task 从 subagent 可见工具集中过滤掉；
      // 能力供给的 extraDisallowed（联网：禁 SDK 内置 WebSearch/WebFetch）一并合入
      disallowedTools: ['Task', ...provision.extraDisallowed],
      toolContext: {
        // 能力供给的 ToolContext patch（联网：独立 searchBudgetId）——放最前，显式字段优先
        ...provision.toolContextPatch,
        // 主对话继承组整组透传（字段见 InheritedToolContext）——onProposal 下面覆盖为 wrapped 版；
        // 此处整组 spread 即「漏传不可能」的兑现。
        ...deps.inherited,
        conversationId: deps.conversationId,
        // 浏览器会话独立桶（S33）：conversationId 与主对话相同（审批卡路由需要），不另给桶 id
        // 会与主对话抢同一个「当前页」——与 searchBudgetId 同款隔离模式。
        browserSessionId: `subagent_${taskId}`,
        agentId: deps.agentId,
        ownerId: deps.ownerId,
        activeProjectId: deps.activeProjectId,
        usage: 'twinSubagent',
        approvalMode: deps.approvalMode,
        abortSignal: derivedAbort.signal,
        // 覆盖继承来的裸 onProposal——注入 triggeredBySubagent + 切 chip 状态（见 wrappedOnProposal）。
        onProposal: wrappedOnProposal,
        onProposalTrace: wrappedOnProposalTrace,
        // chip 不需要包装：它落的是「装了什么」，不区分谁触发（卡片上的溯源行已经说明了）。
        // G72 同步提问通道：askUserChoice 已随继承组挂上；父对话挂了它才补 taskId + askTwinResolver
        // 让 ask_twin 可用（先问背景 Twin、答不上升级用户提问卡）。父对话没挂 → ask_twin 优雅 isError。
        ...(deps.inherited.askUserChoice
          ? {
              taskId,
              askTwinResolver: makeSubagentAskTwinResolver({
                agentId: deps.agentId,
                description: req.description,
                askUserChoice: deps.inherited.askUserChoice,
                abortSignal: derivedAbort.signal,
                conversationId: deps.conversationId,
              }),
            }
          : {}),
        // runSubagent 不挂 → 嵌套保护
      },
    });

    const events = instrumentConversation(
      deps.backend,
      {
        roundId: taskId,
        conversationId: deps.conversationId,
        ownerId: deps.ownerId,
        agentId: deps.agentId,
        agentName: deps.agentName,
        source: 'subagent',
        userText: req.prompt,
        triggerCtx: { description: req.description },
      },
      handle.events,
      fullSystem,
    );
    for await (const ev of events) {
      if (ev.type === 'assistant_text') {
        finalText += ev.text;
        // 运行态：把它说的话推成 activity（speech 优先）
        deps.broadcastChip(
          buildChip({ ...baseRef, activity: { source: 'speech', text: shorten(ev.text) } }),
        );
      } else if (ev.type === 'tool_use') {
        const innerMsg: ChatMessage = {
          id: newMessageId(),
          conversationId: deps.conversationId,
          role: 'assistant',
          text: '',
          toolCalls: [
            {
              id: ev.id,
              name: ev.name,
              input: ev.input,
              status: 'running',
              startedAt: Date.now(),
            },
          ],
          createdAt: Date.now(),
          done: true,
        };
        await appendSidecarMessage(
          deps.ownerId,
          deps.agentId,
          deps.conversationId,
          taskId,
          innerMsg,
        );
        // 运行态：它不吭声时，把当前工具动作翻成 activity（tool，前端淡色兜底）
        deps.broadcastChip(
          buildChip({
            ...baseRef,
            activity: {
              source: 'tool',
              text: `调用工具：${normalizeToolName(ev.name)}`,
              toolName: ev.name,
              toolObject: toolObject(ev.name, ev.input),
            },
          }),
        );
      } else if (ev.type === 'tool_result') {
        // ChatRole 没有 'tool'——用 'system' 表达工具回执，text 字段携带结果
        const innerMsg: ChatMessage = {
          id: newMessageId(),
          conversationId: deps.conversationId,
          role: 'system',
          text:
            (ev.isError ? '[tool_result isError] ' : '[tool_result] ') +
            stringifyToolResultContent(ev.content),
          toolCalls: [],
          createdAt: Date.now(),
          done: true,
        };
        await appendSidecarMessage(
          deps.ownerId,
          deps.agentId,
          deps.conversationId,
          taskId,
          innerMsg,
        );
      } else if (ev.type === 'llm_usage') {
        if (ev.inputTokens != null) inputTok += ev.inputTokens;
        if (ev.outputTokens != null) outputTok += ev.outputTokens;
        if (ev.cacheReadTokens != null) cacheRead += ev.cacheReadTokens;
      } else if (ev.type === 'result') {
        if (ev.isError) {
          isError = true;
          errorMessage = ev.resultText ?? 'subagent failed';
        } else if (ev.resultText) {
          // result 事件的 text 是终态——覆盖累积的 finalText
          finalText = ev.resultText;
        }
      }
    }
  } catch (e) {
    isError = true;
    errorMessage = deps.abortSignal.aborted ? '用户取消' : (e as Error).message ?? 'subagent failed';
  } finally {
    deps.abortSignal.removeEventListener('abort', onParentAbort);
    // 一次性 subagent 预算桶用完即弃，删 Map entry 避免泄漏（与 bg/task 桶同模式）
    finalizeConversationBudget(searchBudgetId);
  }

  // 落 subagent 最终 assistant text 到 sidecar
  if (finalText) {
    const finalSideMsg: ChatMessage = {
      id: newMessageId(),
      conversationId: deps.conversationId,
      role: 'assistant',
      text: finalText,
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    };
    await appendSidecarMessage(
      deps.ownerId,
      deps.agentId,
      deps.conversationId,
      taskId,
      finalSideMsg,
    );
  }

  const completedAt = Date.now();
  const finalRef: SubagentChipRef = {
    ...baseRef,
    status: isError ? 'error' : 'completed',
    finalText: isError ? undefined : finalText,
    errorMessage: isError ? errorMessage : undefined,
    tokenUsage: { input: inputTok, output: outputTok, cacheRead },
    completedAt,
  };
  const finalChip = buildChip(finalRef, finalText || errorMessage || '', true);
  await deps.persistChip(finalChip);

  return isError
    ? { isError: true, text: `subagent 失败: ${errorMessage ?? '未知错误'}` }
    : { text: finalText };
}
