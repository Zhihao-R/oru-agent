/**
 * 通知中心分段 / 对话列表标记的**唯一**状态来源（技术设计 §1）。
 *
 * 状态由两根正交轴合成：
 * - 结局轴 `ConvState`：这一刻对话处于什么状态（done / running / 三种待办 / missed）。
 * - 已读轴 `seen`：你打开验收过没有（`updatedAt > lastSeenAt` 即未读）。
 *
 * 两视图同读同一束 `ConvFacts`、同一处判定——这是"两边一套词汇"的落点：
 * - 通知中心三段 ⟺ `deriveConvBadge` 三值：需要你处理=todo、进行中=running、已完成(待验收)=unread；
 *   none 即不进通知中心。
 * - 对话列表标记 = `deriveConvBadge`（结局轴的有损投影 ⊕ 已读位）。
 */
import type {
  ActionProposal,
  ChatMessage,
  Conversation,
  ScheduledTask,
  SubagentTask,
  TaskStatus,
} from '@shared/types';

export type ConvState =
  | 'running' // 进行中：streaming 或有子任务 running/pending/awaiting_twin
  | 'awaiting-answer' // 等你回答：子任务 awaiting_user
  | 'awaiting-approval' // 等你审批：有 pending proposal（含主 agent 触发，不止 subagent）
  | 'errored' // 出错：最后一轮 chatMessage.error 或 task failed
  | 'missed' // 错过的定时：scheduledTask missedAt（G53 已接真值，见 buildMissedByConv）
  | 'done'; // 已完成：settled，无以上任何待办

export type ConvBadge = 'todo' | 'running' | 'unread' | 'none';

/** 待办类结局——列表合并成一个黄点、通知中心落"需要你处理"段（有意的有损投影） */
const TODO_STATES: ReadonlySet<ConvState> = new Set<ConvState>([
  'awaiting-answer',
  'awaiting-approval',
  'errored',
  'missed',
]);

/**
 * 判定一条对话状态所需的事实切片——两视图各自从 store 投影出来（见 collectConvFacts），
 * 纯函数只读不碰 store。
 */
export type ConvFacts = {
  /** 后端流是否还开着（chatStore.streamingMessageIdByConv[convId] 非空） */
  streaming: boolean;
  /** 本对话全部待审批提案数——数全部 pending，不按 triggeredBySubagent 过滤（承重约束 3） */
  pendingProposals: number;
  /** 本对话关联子任务的状态集 */
  taskStatuses: TaskStatus[];
  /** 最后一条消息是否带 error */
  lastMessageErrored: boolean;
  /** 错过的定时（scheduledTask missedAt）——由 buildMissedByConv 按绑定对话映射（G53） */
  missed?: boolean;
  /** 对话最后更新时刻 */
  updatedAt: number;
  /** 已读水位；缺省 = 从未打开过（未读） */
  lastSeenAt?: number;
};

function isRunning(f: ConvFacts): boolean {
  return (
    f.streaming ||
    f.taskStatuses.some((s) => s === 'running' || s === 'pending' || s === 'awaiting_twin')
  );
}

function isUnread(f: ConvFacts): boolean {
  return f.lastSeenAt === undefined || f.updatedAt > f.lastSeenAt;
}

/**
 * 结局轴：多状态并存时取一个，优先级（高→低）——
 * awaiting-approval > awaiting-answer > errored > missed > running > done。
 * 第一性：实时阻塞（等你点头 / 回答，那一轮真停在 waiter 里、不处理就走不下去）排在事后决定
 * （报错 / 错过——已停下、等你善后）之前；二者都高于自走的 running、已了结的 done。
 * 三种待办映射到列表同一个黄点，故此序对列表标记无碍；通知中心"需要你处理"段渲染全部在场动作卡，
 * 不靠此序二选一（否则并存时会吞掉仍在等的 proposal）。
 */
export function deriveConvState(f: ConvFacts): ConvState {
  if (f.pendingProposals > 0) return 'awaiting-approval';
  if (f.taskStatuses.includes('awaiting_user')) return 'awaiting-answer';
  if (f.lastMessageErrored || f.taskStatuses.includes('failed')) return 'errored';
  if (f.missed) return 'missed';
  if (isRunning(f)) return 'running';
  return 'done';
}

/** 列表标记 = 结局轴投影 ⊕ 已读位。todo > running > unread > none。 */
export function deriveConvBadge(f: ConvFacts): ConvBadge {
  const state = deriveConvState(f);
  if (TODO_STATES.has(state)) return 'todo';
  if (state === 'running') return 'running';
  if (state === 'done' && isUnread(f)) return 'unread';
  return 'none';
}

/**
 * 施加"忽略"后的有效 badge——列表 / 通知中心 / 角标三处共用，保证「中心需要你处理的集合 ==
 * 列表黄点的集合」这条不变量（忽略只在三处一起生效，绝不只隐藏角标而留下列表黄点说谎）。
 *
 * 可忽略 = 报错 / 错过定时 / 完成待验收（2026-07-10 PM 拍板把待验收扩入）：抹掉这些信号后重判，
 * 让对话沉到底下的真实状态（仍在跑 / 无）。审批 / 回答类不受忽略影响——若沉下去仍有 pending
 * proposal 等你审批，自然复现，必须继续摆在你面前。
 */
export function effectiveBadge(f: ConvFacts, dismissed: boolean): ConvBadge {
  if (!dismissed) return deriveConvBadge(f);
  return deriveConvBadge({
    ...f,
    lastMessageErrored: false,
    missed: false,
    taskStatuses: f.taskStatuses.filter((s) => s !== 'failed'),
    // 完成待验收（done 且未读）同被这次忽略盖掉：视作已读；新动静复现由 dismissedAt 水位保证
    lastSeenAt: f.updatedAt,
  });
}

// ─── 投影：从 store 切片收集单条对话的事实 ──────────────────────────

/** collectConvFacts 的入参——透传现有 store 切片，不新增数据通道 */
export type ConvStatusDeps = {
  /** chatStore.streamingMessageIdByConv */
  streamingMessageIdByConv: Record<string, string | null>;
  /** taskStore.proposalsByConv */
  proposalsByConv: Record<string, ActionProposal[]>;
  /** 按 conv 分桶的子任务（用 groupTasksByConv 从 taskStore.tasks 投影一次） */
  tasksByConv: Record<string, SubagentTask[]>;
  /** chatStore.conversations（按 conv 的消息列表） */
  messagesByConv: Record<string, ChatMessage[]>;
  /** conversationStore.byId */
  convById: Record<string, Conversation>;
  /** 错过的定时——useNotifications 接 buildMissedByConv 的真值（G53） */
  missedByConv?: Record<string, boolean>;
};

/** taskStore.tasks（按 id）→ 按 conversationId 分桶。组件 useMemo 一次，避免逐行 O(任务数)。 */
export function groupTasksByConv(
  tasks: Record<string, SubagentTask>,
): Record<string, SubagentTask[]> {
  const out: Record<string, SubagentTask[]> = {};
  for (const t of Object.values(tasks)) {
    (out[t.conversationId] ??= []).push(t);
  }
  return out;
}

/**
 * 错过的定时任务 → 承载对话（G53）：missedAt 非空且 runLocation 指向某条对话的任务，把那条对话
 * 标 missed（进「需要你处理」）。每次新建独立对话的（newConversation）无 conv 可挂，仍由定时任务页
 * 的「未能触发」区呈现，不进对话轴。
 */
export function buildMissedByConv(tasks: ScheduledTask[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const t of tasks) {
    if (t.missedAt != null && t.runLocation.kind === 'conversation') out[t.runLocation.id] = true;
  }
  return out;
}

export function collectConvFacts(convId: string, deps: ConvStatusDeps): ConvFacts {
  const conv = deps.convById[convId];
  const messages = deps.messagesByConv[convId] ?? [];
  const lastMessage = messages[messages.length - 1];
  return {
    streaming: deps.streamingMessageIdByConv[convId] != null,
    // code 派工为本对话后台排队/运行，非「待你审批」——不计入 awaiting-approval（改动点4）
    pendingProposals: (deps.proposalsByConv[convId] ?? []).filter(
      (p) => p.status === 'pending' && p.kind !== 'code',
    ).length,
    taskStatuses: (deps.tasksByConv[convId] ?? []).map((t) => t.status),
    lastMessageErrored: lastMessage?.error != null,
    missed: deps.missedByConv?.[convId] ?? false,
    updatedAt: conv?.updatedAt ?? 0,
    lastSeenAt: conv?.lastSeenAt,
  };
}
