/**
 * 消息流前端 store——按 conversationId 分桶
 *
 * 关于 active conversation：
 * - active conversation 由 conversationStore 管，本 store 不维护
 * - send() 不收 convId 入参：发送动作语义锚定在用户当前所在对话，active 即语义来源；
 *   函数头同步取 convId 后冻结，整轮发送走同一个 conv
 * - abort() / retryLast() 收 convId 入参：操作归属是 message 所属 conv，跟 active 解耦——
 *   用户在 A 的 message 上点 stop 但已切到 B，仍应 abort A
 */
import { create } from 'zustand';
import type {
  AskUserChoiceAnswers,
  AskUserChoiceQuestion,
  ChatAttachment,
  ChatDelta,
  ChatMessage,
  ChatRef,
  HandbackItem,
  ToolCall,
  ToolResult,
} from '@shared/types';
import { handbackForm } from '@shared/agent/handback';
import type {
  ChatRetryingEvent,
  ChatErrorEvent,
  ChatSteeringAddedEvent,
  ChatSteeringConsumedEvent,
  ChatSteeringRecoveredEvent,
  ChatSteeringWithdrawResultEvent,
  ChatQueueHandbackEvent,
  ChatAbortResultEvent,
} from '@shared/protocol';
import { newMessageId, newChatRefId } from '@shared/ids';
import { buildMessageWithRefs } from '@/lib/buildMessageWithRefs';
import { insertContextCompressed } from '@/lib/contextCompressedInsert';
import { derivePhase, isTerminalPhase, lastTurnTerminusCandidate } from '@/lib/streamPhase';
import { wsClient } from '@/lib/ws';
import {
  buildPendingAttachments,
  checkCountLimit,
  toOptimisticAttachments,
  toWireAttachments,
  revokeBlobUrls,
  type PendingAttachment,
} from '@/lib/imageAttachments';
import { useAgentStore } from './agentStore';
import { useConversationStore } from './conversationStore';
import i18n from '@/lib/i18n';

type SessionMap = Record<string, ChatMessage[]>;
type LastSent = { text: string; attachments: PendingAttachment[] | null };

/**
 * 一张待答的「带选项提问」卡（ask_user_choice）。pending 态只活在实时 WS 流里、不进持久化——
 * 答完由同一 tool 的 chat.toolResult（result.structured）承载只读小结与 replay。
 * disabled：本轮被停止 / 报错中断 → 卡片置灰失效，不能再答。
 */
export type AskUserChoicePending = {
  askId: string;
  conversationId: string;
  messageId: string;
  questions: AskUserChoiceQuestion[];
  disabled?: boolean;
};

/**
 * 断路器跳闸卡（G01/G04）——工具调用失控（连续失败 / 异常频繁）时弹出，让用户点「继续放行 / 停止」。
 * 只活在实时流里，不持久化；本轮被停止 / 报错则置灰失效。
 */
export type CircuitBreakPending = {
  breakerId: string;
  conversationId: string;
  messageId: string;
  reason: 'consecutive-failures' | 'high-frequency';
  disabled?: boolean;
};

type ChatStoreState = {
  /** 按 conversationId 索引的消息列表 */
  conversations: SessionMap;
  /** 按 conv 分桶：锁输入框 / 防重复发送。abort 守卫不读此值——「能否中止」看 streamingMessageIdByConv */
  pendingByConv: Record<string, boolean>;
  /** 按 conv 分桶：当前流式中的 messageId。既是 abort 目标，也是「后端流是否还开着」的权威 */
  streamingMessageIdByConv: Record<string, string | null>;
  /**
   * 按 conv 分桶：上一次发送的 user 消息内容，[重试] 用。
   * 不主动清——下次 send 覆盖；持有 File 引用直到下次覆盖
   */
  lastSentByConv: Record<string, LastSent | null>;
  /** 按 conv 分桶：输入框草稿 */
  draftTextByConv: Record<string, string>;
  /**
   * 按 conv 分桶：待发送图片附件（与 draftTextByConv 同构，切对话不清空）。
   * 累积权衡（已接受）：附件持有 File 引用 + blob URL（单 conv ≤8 张、单张 ≤5MB），切对话
   * 不清会跨多 conv 累积到 send / removeAttachment / loadHistory 才释放。单用户、conv 数个位数，
   * 体量有界可接受——换取与草稿一致的"切回来还在"体验。
   */
  attachmentsByConv: Record<string, PendingAttachment[]>;
  /**
   * 按 conv 分桶：选段「加入对话」落进 composer 的引用 chip。发送时由 buildMessageWithRefs
   * 渲染成只读上下文块拼进消息，发完即清空。与 draftTextByConv 同构、切对话不清。
   */
  composerRefsByConv: Record<string, ChatRef[]>;
  /**
   * 按 conv 分桶：Loop 模式开关。开＝这条待发消息以 Loop 收敛跑。它是**发送意图**不是文字——
   * 送出前才在 chatStore 外由 ChatInput 前置 `/loop `（backend parseLoopCommand 的契约），
   * 输入框里只呈现一枚 `/loop` 标签。与 draftTextByConv 同构、切对话保留、发完清。
   */
  loopModeByConv: Record<string, boolean>;
  /** 待答的「带选项提问」卡，按 askId 索引（并发多 ask 互不覆盖）。只活在实时流里，不进持久化 */
  pendingAsks: Record<string, AskUserChoicePending>;
  /**
   * 按 conv 分桶：交还的「待处理项」（S08 · G14）——故障 / 中断 / 崩溃恢复时，机器触发与渠道
   * 消息交还成待处理项列在 composer 上方，每条可放行 / 清掉。桌面用户亲手打的字不进这里（回填草稿）。
   * 只活在前端（盘记已在交还时清）；切对话保留、放行/清掉后移除。
   */
  pendingHandbackByConv: Record<string, HandbackItem[]>;
  /** 只承接 pre-locate 错误（取不到 agent/conv）；网络错误写到 chatMessage.error */
  error: string | null;
  appendDelta: (conversationId: string, messageId: string, delta: ChatDelta) => void;
  startAssistantMessage: (conversationId: string, messageId: string) => void;
  addToolCall: (conversationId: string, messageId: string, tool: ToolCall) => void;
  updateToolResult: (conversationId: string, messageId: string, result: ToolResult) => void;
  /** G19：把前台命令实时输出追加到该消息里正在运行的 bash 工具卡（纯前端瞬态，只给人看）。 */
  appendCommandOutput: (conversationId: string, messageId: string, chunk: string) => void;
  markDone: (conversationId: string, messageId: string) => void;
  /**
   * 断连/中断丢了 chat.done 时的兜底对账（正常路径仍由 chat.done→markDone 清）。
   * pendingByConv 是会卡死的乐观投影；本方法改以「末条 assistant 是否终态」为依据——后端持久化、
   * 活过断连的地面真相。末条已终态却仍 pending = chat.done 丢了，把回合括起标志
   * （pendingByConv / streamingMessageIdByConv）清诚实。retryLast/send 决策前各调一次。
   */
  reconcileBusyState: (conversationId: string) => void;
  /** 处理 chat.askUserChoice：挂一张待答的提问卡 */
  addPendingAsk: (
    conversationId: string,
    messageId: string,
    askId: string,
    questions: AskUserChoiceQuestion[],
  ) => void;
  /**
   * 用户点「提交」：把全卡回答交给后端,成功后移除待答卡（只读小结由后续 chat.toolResult 承载）。
   * WS 失败会抛——卡片保留可重试，绝不静默移除导致死挂（调用方据此复位提交态）。
   */
  answerUserChoice: (askId: string, answers: AskUserChoiceAnswers) => Promise<void>;
  /** 本轮被停止 / 报错中断：该 conv 所有待答卡置灰失效 */
  disablePendingAsks: (conversationId: string) => void;
  /**
   * 睡眠唤醒对账（sleep-wake-chat-recovery）：把主进程给的「真相快照」应用到对话——
   * 半截接回（inflightPartial → messageId 所在消息补正文 / 工具调用）、待答卡重新挂上
   * （重置 disabled，让用户能继续点）、running=false 分支走中断呈现（卡置灰）。
   */
  applyPendingTurnState: (result: {
    conversationId: string;
    running: boolean;
    pendingAsks: { askId: string; questions: AskUserChoiceQuestion[] }[];
    inflightPartial: { messageId: string; text: string; toolCalls: ToolCall[] } | null;
  }) => void;
  /** 断路器跳闸卡（G01/G04）——按 breakerId 索引，只活在实时流里 */
  pendingBreaks: Record<string, CircuitBreakPending>;
  /** 收到 chat.circuitBreak：挂一张跳闸卡 */
  addPendingBreak: (ev: {
    conversationId: string;
    messageId: string;
    breakerId: string;
    reason: 'consecutive-failures' | 'high-frequency';
  }) => void;
  /** 用户点「继续放行 / 停止」：发决定给后端并移除卡片 */
  circuitBreakDecision: (breakerId: string, decision: 'resume' | 'stop') => Promise<void>;
  /** 本轮被停止 / 报错中断：该 conv 所有跳闸卡置灰失效 */
  disablePendingBreaks: (conversationId: string) => void;
  /** 处理 chat.retrying：写 message.retryAttempt */
  handleRetrying: (ev: ChatRetryingEvent) => void;
  /** 处理 chat.error：写 message.error */
  handleChatError: (ev: ChatErrorEvent) => void;
  appendUserMessage: (
    conversationId: string,
    text: string,
    attachments?: ChatAttachment[],
    opts?: { clientMsgId?: string; steering?: ChatMessage['steering'] },
  ) => ChatMessage;
  loadHistory: (conversationId: string, messages: ChatMessage[]) => void;
  send: (text: string, attachments?: PendingAttachment[]) => Promise<void>;
  /** 用户主动 Stop 当前流式 turn——操作归属由调用方传入 */
  abort: (conversationId: string) => Promise<void>;
  /**
   * Steering：撤回一条还在服务端队列、未被读入的「将生效」消息。乐观置「撤回中」（不删），
   * 按服务端回执 removed→移除 / alreadyConsumed→落定为已读入（不可逆删的禁令：删/落定等回执）。
   */
  withdrawSteering: (conversationId: string, clientMsgId: string) => Promise<void>;
  /** 处理 chat.steering.added（广播）：忙时入队回执——把乐观「将生效」气泡对齐 serverId。 */
  handleSteeringAdded: (ev: ChatSteeringAddedEvent) => void;
  /** 处理 chat.steering.consumed（广播）：一批「将生效」在边界被读入——气泡落定为普通消息。 */
  handleSteeringConsumed: (ev: ChatSteeringConsumedEvent) => void;
  /** 处理 chat.steering.recovered（广播）：崩溃盘记交还——按类型分流后回 recoverAck 确认送达。 */
  handleSteeringRecovered: (ev: ChatSteeringRecoveredEvent) => void;
  /** 处理 chat.queue.handback（广播）：故障 / 远程刹车后队列交还——按类型分流为草稿 / 待处理项。 */
  handleQueueHandback: (ev: ChatQueueHandbackEvent) => void;
  /**
   * 交还分流单源（G14）：把一批交还项按 handbackForm 分成草稿（回填输入框）与待处理项（列 UI）。
   * abort 回执 / 崩溃恢复 / 故障交还三路共用。
   */
  applyHandback: (conversationId: string, items: HandbackItem[]) => void;
  /** 放行一个待处理项：按原投影重新入队（chat.queue.readmit），乐观从列表移除。 */
  readmitPending: (conversationId: string, item: HandbackItem) => Promise<void>;
  /** 清掉一个待处理项：前端丢弃即可（盘记已在交还时清）。 */
  dismissPending: (conversationId: string, item: HandbackItem) => void;
  /** [重试] 按钮点击：重发指定 conv 上一次的 user 消息 */
  retryLast: (conversationId: string) => Promise<void>;
  /** 输入框草稿写入 */
  setDraftText: (conversationId: string, text: string) => void;
  /** Loop 模式开关写入（发送意图；`/loop` 标签的真相源） */
  setLoopMode: (conversationId: string, on: boolean) => void;
  /**
   * 校验（MIME/大小/数量）+ 建 blob URL + 追加；返回拒绝原因（null=全成功）。
   * visionEnabled 是 UI 上下文门槛，不在此校验——由 ChatInput 调用前自己拦。
   */
  addAttachments: (convId: string, files: File[]) => string | null;
  /** 直接替换（不 revoke——caller 决定生命周期，发送后清空走这个，blob URL 仍被乐观气泡引用） */
  setAttachments: (convId: string, items: PendingAttachment[]) => void;
  /** 手动移除单张：revoke blob URL + 移除（X 按钮用） */
  removeAttachment: (convId: string, id: string) => void;
  /** 选段「加入对话」：往该 conv 的 composer 追加一条引用 chip */
  addComposerRef: (convId: string, ref: ChatRef) => void;
  /**
   * 整文件「引用到对话」：右键 / 拖拽文件树条目都走它——ChatRef{kind:'file'} 的形状只在这一处构造
   * （quote=文件名供 chip 展示、sourcePath=相对路径让 agent 去读）。convId 由 caller 解析后传入。
   */
  addFileRef: (convId: string, file: { path: string; name: string }) => void;
  /** 叉掉一条引用 chip */
  removeComposerRef: (convId: string, id: string) => void;
  /** 清空该 conv 的引用 chip（发送后调用） */
  clearComposerRefs: (convId: string) => void;
  /**
   * 草稿桶引用搬到真会话（发首条消息建会话时调用）：追加到目标、清空源桶。
   * 文本/附件靠 onSend 参数交接，引用没有参数通道，靠它在草稿→真对话切换时不丢失。
   */
  migrateComposerRefs: (fromKey: string, toConvId: string) => void;
  /** 整卡追加（同 id 跳过去重）：chat.memoryRecord / taskboard 评论卡 / aside 指代卡回流共用 */
  insertSpecialMessage: (msg: ChatMessage) => void;
  /** context-compressed 卡专用：插到被压缩内容之后而非末尾（一期文档 §四），避免贴输入框。 */
  insertContextCompressedMessage: (msg: ChatMessage) => void;
  /**
   * 主进程推 chat.subagentChip 时——同 id 覆盖（运行中状态会反复 update）。
   * 跟 insertSpecialMessage 的"同 id 跳过"语义不同，单独一个方法避免污染其他卡片。
   */
  upsertSubagentChip: (msg: ChatMessage) => void;
  /** 主进程推 chat.loopCard 时——同 id 覆盖（Loop 活动卡编译→逐轮→收敛全程一张卡反复 update）。 */
  upsertLoopCard: (msg: ChatMessage) => void;
  /** 按 id 移除一条消息（S18：定时任务结果落盘时移除开跑时合成的「执行中」临时卡）。 */
  removeMessage: (conversationId: string, messageId: string) => void;
  /** 主进程推 chat.memoryUndone 时——把对应 memory-record 卡片标 undone */
  markMemoryUndone: (conversationId: string, messageId: string) => void;
};

function getOrCreateMessage(
  list: ChatMessage[],
  conversationId: string,
  messageId: string,
  role: ChatMessage['role'],
): { list: ChatMessage[]; index: number } {
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx >= 0) return { list, index: idx };
  const next: ChatMessage = {
    id: messageId,
    conversationId,
    role,
    text: '',
    toolCalls: [],
    createdAt: Date.now(),
    done: false,
  };
  return { list: [...list, next], index: list.length };
}

/**
 * 把网络错误塞进该 conv 的消息流，让用户看见——
 * - 末条是 assistant（retry 失败的常见场景）：直接写到它的 error 字段，StreamStatusBar 会渲染
 * - 否则（末条是 user / 卡片，常见 send 失败场景）：追加一条 errored assistant message，
 *   保持跟 chat.error 事件路径一致的呈现（红色状态行 + 重试按钮）
 */
export function attachNetworkErrorToLast(
  conversations: SessionMap,
  convId: string,
  message: string,
): SessionMap {
  const list = conversations[convId] ?? [];
  const errorInfo = { message, retryable: true };
  if (list.length > 0) {
    const last = list[list.length - 1];
    if (last.role === 'assistant') {
      const next = [...list];
      next[next.length - 1] = { ...last, error: errorInfo };
      return { ...conversations, [convId]: next };
    }
  }
  // 追加一条 errored assistant placeholder——StreamStatusBar 据此渲染错误 + retry
  const placeholder: ChatMessage = {
    id: newMessageId(),
    conversationId: convId,
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    error: errorInfo,
  };
  return { ...conversations, [convId]: [...list, placeholder] };
}

/**
 * 当前 agent 的输入框（composer）分桶 key：有活跃对话用其 id，否则落到 per-agent 草稿桶。
 * 草稿/附件/引用三类 composer 状态都按它分桶——ChatArea、文件树「引用到对话」共用这一处解析，
 * 否则两端 key 口径不一致会把引用写进对方读不到的桶（新对话引用丢失即源于此）。
 */
/** 空引用列表的稳定引用——selector 里 `?? []` 每次都是新数组，会把订阅者拖进无谓重渲染。 */
export const EMPTY_REFS: ChatRef[] = [];

export function composerKey(agentId: string | null, activeConvId: string | null): string | null {
  if (!agentId) return null;
  return activeConvId ?? `draft:${agentId}`;
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  conversations: {},
  pendingByConv: {},
  streamingMessageIdByConv: {},
  lastSentByConv: {},
  draftTextByConv: {},
  attachmentsByConv: {},
  composerRefsByConv: {},
  loopModeByConv: {},
  pendingAsks: {},
  pendingBreaks: {},
  pendingHandbackByConv: {},
  error: null,
  startAssistantMessage(conversationId, messageId) {
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      const { list: next } = getOrCreateMessage(list, conversationId, messageId, 'assistant');
      return {
        conversations: { ...s.conversations, [conversationId]: next },
        streamingMessageIdByConv: {
          ...s.streamingMessageIdByConv,
          [conversationId]: messageId,
        },
        // pending = 后端正为此 conv 流式（chat.started → chat.done 括起，跟谁发起无关），
        // 用途单一：锁输入框 / 防重复发送。send()/retryLast() 提前置 true 只是 ws 往返期的
        // 乐观预闪；后端自发起的回合（maybeResumeTurn 续跑 / idle 播报）不走 send，靠这里补 true
        // 才会锁住输入。（中止与否不看它，看 streamingMessageId——见 abort()。）
        pendingByConv: { ...s.pendingByConv, [conversationId]: true },
      };
    });
  },
  appendDelta(conversationId, messageId, delta) {
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      const { list: ensured, index } = getOrCreateMessage(
        list,
        conversationId,
        messageId,
        'assistant',
      );
      const target = ensured[index];
      const updated: ChatMessage = {
        ...target,
        text: delta.textChunk ? target.text + delta.textChunk : target.text,
        // 收到首个 delta → 上一次的 retry 算成功，清零计数
        retryAttempt: undefined,
      };
      const nextList = [...ensured];
      nextList[index] = updated;
      return { conversations: { ...s.conversations, [conversationId]: nextList } };
    });
  },
  addToolCall(conversationId, messageId, tool) {
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      const { list: ensured, index } = getOrCreateMessage(
        list,
        conversationId,
        messageId,
        'assistant',
      );
      const target = ensured[index];
      const existingIdx = target.toolCalls.findIndex((t) => t.id === tool.id);
      const nextCalls =
        existingIdx >= 0
          ? target.toolCalls.map((t, i) => (i === existingIdx ? { ...t, ...tool } : t))
          : [...target.toolCalls, tool];
      const nextList = [...ensured];
      nextList[index] = { ...target, toolCalls: nextCalls };
      return { conversations: { ...s.conversations, [conversationId]: nextList } };
    });
  },
  updateToolResult(conversationId, messageId, result) {
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      const idx = list.findIndex((m) => m.id === messageId);
      if (idx < 0) return s;
      const target = list[idx];
      const nextCalls = target.toolCalls.map((t) =>
        t.id === result.toolCallId
          ? {
              ...t,
              status: result.isError ? ('error' as const) : ('success' as const),
              result,
              finishedAt: Date.now(),
            }
          : t,
      );
      const nextList = [...list];
      nextList[idx] = { ...target, toolCalls: nextCalls };
      return { conversations: { ...s.conversations, [conversationId]: nextList } };
    });
  },
  appendCommandOutput(conversationId, messageId, chunk) {
    // 只保留末尾这么多字符——实时输出是给人看最新进展的，无需在内存里堆整段构建日志。
    const LIVE_CAP = 16 * 1024;
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      const idx = list.findIndex((m) => m.id === messageId);
      if (idx < 0) return s;
      const target = list[idx];
      // 命中该消息里正在运行的 bash 工具卡（前台一次只跑一条，取最后一个 running 的 bash）。
      let hitId: string | undefined;
      for (const t of target.toolCalls) {
        if (t.status === 'running' && /(^|_)bash$/.test(t.name)) hitId = t.id;
      }
      if (!hitId) return s;
      const nextCalls = target.toolCalls.map((t) => {
        if (t.id !== hitId) return t;
        const merged = (t.commandOutput ?? '') + chunk;
        return { ...t, commandOutput: merged.slice(-LIVE_CAP) };
      });
      const nextList = [...list];
      nextList[idx] = { ...target, toolCalls: nextCalls };
      return { conversations: { ...s.conversations, [conversationId]: nextList } };
    });
  },
  markDone(conversationId, messageId) {
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      const idx = list.findIndex((m) => m.id === messageId);
      // 按 conv 取，避免误清其他 conv 的 streaming
      const prevStreaming = s.streamingMessageIdByConv[conversationId] ?? null;
      const nextStreaming = prevStreaming === messageId ? null : prevStreaming;
      const partial = {
        pendingByConv: { ...s.pendingByConv, [conversationId]: false },
        streamingMessageIdByConv: {
          ...s.streamingMessageIdByConv,
          [conversationId]: nextStreaming,
        },
      };
      if (idx < 0) return partial;
      const next = [...list];
      next[idx] = { ...next[idx], done: true };
      return {
        conversations: { ...s.conversations, [conversationId]: next },
        ...partial,
      };
    });
  },
  reconcileBusyState(conversationId) {
    set((s) => {
      if (!s.pendingByConv[conversationId]) return s; // 非忙，无需对账
      const list = s.conversations[conversationId] ?? [];
      // 跳过非当前回合产物（卡片 / 后台产出）后取末条——卡片落在终态回复之后会遮蔽终态，
      // 旧判据「数组末条是不是终态 assistant」在那种排布下永远判不出回合已结束。
      const last = lastTurnTerminusCandidate(list);
      // 终态 assistant = 回合已结束；非 assistant（刚发的 user 半截）或进行中态 = 回合真在途，不动。
      if (!last || last.role !== 'assistant' || !isTerminalPhase(derivePhase(last))) return s;
      return {
        pendingByConv: { ...s.pendingByConv, [conversationId]: false },
        streamingMessageIdByConv: { ...s.streamingMessageIdByConv, [conversationId]: null },
      };
    });
  },
  addPendingAsk(conversationId, messageId, askId, questions) {
    set((s) => ({
      pendingAsks: {
        ...s.pendingAsks,
        [askId]: { askId, conversationId, messageId, questions },
      },
    }));
  },
  async answerUserChoice(askId, answers) {
    // 先发后移除：WS 失败则抛、卡片保留可重试，绝不静默移除——否则后端 waiter 仍在等、本轮死挂而
    // 用户却找不到重新提交的入口。成功后再移除，只读小结由随即到达的 chat.toolResult 承载。
    await wsClient.request({ type: 'chat.answerUserChoice', askId, answers });
    set((s) => {
      if (!s.pendingAsks[askId]) return s;
      const next = { ...s.pendingAsks };
      delete next[askId];
      return { pendingAsks: next };
    });
  },
  applyPendingTurnState({ conversationId, running, pendingAsks, inflightPartial }) {
    // 睡眠唤醒对账：把主进程真相快照应用到前端。
    // 1) 半截接回：messageId 已存在（历史里）→ 补正文/工具调用；不存在（从未落盘）→ 新建一条
    //    半截 assistant 消息，并开 streaming 标志（停止按钮可见、锁输入框），让用户能续看/停止。
    let streamingMsgId: string | null = null;
    const hasInflight = !!inflightPartial;
    const hasPendingAsk = pendingAsks.length > 0;
    // 对账后是否「回合在途（可继续等/可操作）」：running=true 且（有半截或有待答卡）才锁输入框
    // 防并发。running=false（外部真掐断）时不锁——中断场景应恢复可发新消息；空快照也不误锁。
    const inFlight = running && (hasInflight || hasPendingAsk);
    const listUpdate = (s: ChatStoreState): ChatMessage[] => {
      if (!inflightPartial) return s.conversations[conversationId] ?? [];
      const { list, index } = getOrCreateMessage(
        s.conversations[conversationId] ?? [],
        conversationId,
        inflightPartial.messageId,
        'assistant',
      );
      const target = list[index];
      const next = [...list];
      next[index] = {
        ...target,
        text: target.text || inflightPartial.text,
        toolCalls:
          target.toolCalls.length > 0 ? target.toolCalls : inflightPartial.toolCalls,
        done: false,
      };
      // 半截流只标志开给「活着」分支（running=true）：中断分支半截已是终态语义，不再当作在流。
      streamingMsgId = running ? inflightPartial.messageId : null;
      return next;
    };
    set((s) => {
      const messages = listUpdate(s);
      return {
        conversations: { ...s.conversations, [conversationId]: messages },
        streamingMessageIdByConv: {
          ...s.streamingMessageIdByConv,
          [conversationId]: streamingMsgId,
        },
        pendingByConv: inFlight
          ? { ...s.pendingByConv, [conversationId]: true }
          : s.pendingByConv,
      };
    });
    // 2) 待答卡重建：清掉该 conv 旧的 pendingAsks（可能与真相不符），再按 truth 重新挂上。
    //    重置 disabled=false（睡眠前若卡被置灰过，唤醒后仍能继续点）。running=false（真中断）
    //    时保持卡存活但不重置 disabled——避免把「已中断」的卡重新激活。
    set((s) => {
      const keep: Record<string, AskUserChoicePending> = {};
      for (const [id, ask] of Object.entries(s.pendingAsks)) {
        if (ask.conversationId !== conversationId) keep[id] = ask;
      }
      for (const p of pendingAsks) {
        keep[p.askId] = {
          askId: p.askId,
          conversationId,
          messageId: inflightPartial?.messageId ?? '',
          questions: p.questions,
          disabled: running ? false : true,
        };
      }
      return { pendingAsks: keep };
    });
    // 3) running=false（外部真掐断）：半截已呈现，但没有活回合——无需额外禁用卡（卡已是 disabled），
    //    对话可发新消息由既有 pendingByConv 流逻辑承接。这里仅确保半截不残留「还在流」的错觉
    //    （done 保持 false——若用户不想等，走停止按钮落盘中断半截）。
  },
  disablePendingAsks(conversationId) {
    set((s) => {
      let changed = false;
      const next: Record<string, AskUserChoicePending> = {};
      for (const [id, ask] of Object.entries(s.pendingAsks)) {
        if (ask.conversationId === conversationId && !ask.disabled) {
          next[id] = { ...ask, disabled: true };
          changed = true;
        } else {
          next[id] = ask;
        }
      }
      return changed ? { pendingAsks: next } : s;
    });
  },
  addPendingBreak({ conversationId, messageId, breakerId, reason }) {
    set((s) => ({
      pendingBreaks: {
        ...s.pendingBreaks,
        [breakerId]: { breakerId, conversationId, messageId, reason },
      },
    }));
  },
  async circuitBreakDecision(breakerId, decision) {
    // 先发后移除（同 answerUserChoice）：WS 失败则抛、卡片保留可重试，绝不静默移除害后端 waiter 死等。
    const conv = get().pendingBreaks[breakerId];
    if (!conv) return;
    const agentId = useConversationStore.getState().byId[conv.conversationId]?.agentId;
    if (!agentId) return;
    await wsClient.request({
      type: 'chat.circuitBreakDecision',
      agentId,
      conversationId: conv.conversationId,
      breakerId,
      decision,
    });
    set((s) => {
      if (!s.pendingBreaks[breakerId]) return s;
      const next = { ...s.pendingBreaks };
      delete next[breakerId];
      return { pendingBreaks: next };
    });
  },
  disablePendingBreaks(conversationId) {
    set((s) => {
      let changed = false;
      const next: Record<string, CircuitBreakPending> = {};
      for (const [id, b] of Object.entries(s.pendingBreaks)) {
        if (b.conversationId === conversationId && !b.disabled) {
          next[id] = { ...b, disabled: true };
          changed = true;
        } else {
          next[id] = b;
        }
      }
      return changed ? { pendingBreaks: next } : s;
    });
  },
  handleRetrying(ev) {
    set((s) => {
      const list = s.conversations[ev.conversationId] ?? [];
      const idx = list.findIndex((m) => m.id === ev.messageId);
      if (idx < 0) return s;
      const next = [...list];
      next[idx] = { ...next[idx], retryAttempt: ev.attempt };
      return { conversations: { ...s.conversations, [ev.conversationId]: next } };
    });
  },
  handleChatError(ev) {
    // 本轮报错中断：该 conv 待答的提问卡 + 断路器跳闸卡置灰失效（PRD 异常情况）
    get().disablePendingAsks(ev.conversationId);
    get().disablePendingBreaks(ev.conversationId);
    set((s) => {
      const list = s.conversations[ev.conversationId] ?? [];
      const idx = list.findIndex((m) => m.id === ev.messageId);
      if (idx < 0) return s;
      const next = [...list];
      next[idx] = {
        ...next[idx],
        error: { message: ev.message, retryable: ev.retryable },
      };
      return { conversations: { ...s.conversations, [ev.conversationId]: next } };
    });
  },
  appendUserMessage(conversationId, text, attachments, opts) {
    const msg: ChatMessage = {
      id: newMessageId(),
      conversationId,
      role: 'user',
      text,
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
      attachments,
      clientMsgId: opts?.clientMsgId,
      steering: opts?.steering,
    };
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      return { conversations: { ...s.conversations, [conversationId]: [...list, msg] } };
    });
    return msg;
  },
  loadHistory(conversationId, messages) {
    set((s) => {
      // 替换前 revoke 旧消息里的 blob URL（前端发送态遗留），避免内存泄漏
      // 服务端拉来的 displayUrl 都是 oru-conv-img:// 开头，不会误 revoke
      const old = s.conversations[conversationId] ?? [];
      for (const m of old) revokeBlobUrls(m.attachments);
      return { conversations: { ...s.conversations, [conversationId]: messages } };
    });
  },
  insertSpecialMessage(msg) {
    set((s) => {
      const list = s.conversations[msg.conversationId] ?? [];
      // 同 id 已存在则跳过（防重复）
      if (list.some((m) => m.id === msg.id)) return s;
      return { conversations: { ...s.conversations, [msg.conversationId]: [...list, msg] } };
    });
  },
  insertContextCompressedMessage(msg) {
    set((s) => {
      const list = s.conversations[msg.conversationId] ?? [];
      const next = insertContextCompressed(list, msg);
      if (next === list) return s; // 同 id 已存在，原样返回
      return { conversations: { ...s.conversations, [msg.conversationId]: next } };
    });
  },
  upsertSubagentChip(msg) {
    set((s) => {
      const list = s.conversations[msg.conversationId] ?? [];
      const idx = list.findIndex((m) => m.id === msg.id);
      if (idx >= 0) {
        const next = [...list];
        next[idx] = msg;
        return { conversations: { ...s.conversations, [msg.conversationId]: next } };
      }
      return { conversations: { ...s.conversations, [msg.conversationId]: [...list, msg] } };
    });
  },
  upsertLoopCard(msg) {
    // 同 upsertSubagentChip：按 id 就地覆盖（运行中反复 update），不复用 insertSpecialMessage 的"同 id 跳过"。
    set((s) => {
      const list = s.conversations[msg.conversationId] ?? [];
      const idx = list.findIndex((m) => m.id === msg.id);
      if (idx >= 0) {
        const next = [...list];
        next[idx] = msg;
        return { conversations: { ...s.conversations, [msg.conversationId]: next } };
      }
      return { conversations: { ...s.conversations, [msg.conversationId]: [...list, msg] } };
    });
  },
  removeMessage(conversationId, messageId) {
    set((s) => {
      const list = s.conversations[conversationId];
      if (!list) return s;
      const next = list.filter((m) => m.id !== messageId);
      if (next.length === list.length) return s;
      return { conversations: { ...s.conversations, [conversationId]: next } };
    });
  },
  markMemoryUndone(conversationId, messageId) {
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      const next = list.map((m) =>
        m.id === messageId && m.kind === 'memory-record' && m.memoryRecord
          ? { ...m, memoryRecord: { ...m.memoryRecord, undone: true } }
          : m,
      );
      return { conversations: { ...s.conversations, [conversationId]: next } };
    });
  },
  setDraftText(conversationId, text) {
    set((s) => ({
      draftTextByConv: { ...s.draftTextByConv, [conversationId]: text },
    }));
  },
  setLoopMode(conversationId, on) {
    set((s) => ({
      loopModeByConv: { ...s.loopModeByConv, [conversationId]: on },
    }));
  },
  addAttachments(convId, files) {
    // 格式 / 单张大小校验 + 建 blob URL（总数超限会在 set 回调里 revoke）
    const { accepted, reason: badReason } = buildPendingAttachments(files);
    if (badReason) return badReason;
    // 数量上限必须在 set 回调内用最新 prev 算，避免连续添加时的不一致
    let reason: string | null = null;
    set((s) => {
      const prev = s.attachmentsByConv[convId] ?? [];
      reason = checkCountLimit(prev.length, accepted);
      if (reason) return s;
      return { attachmentsByConv: { ...s.attachmentsByConv, [convId]: [...prev, ...accepted] } };
    });
    return reason;
  },
  setAttachments(convId, items) {
    set((s) => ({ attachmentsByConv: { ...s.attachmentsByConv, [convId]: items } }));
  },
  removeAttachment(convId, id) {
    set((s) => {
      const prev = s.attachmentsByConv[convId] ?? [];
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.displayUrl);
      return { attachmentsByConv: { ...s.attachmentsByConv, [convId]: prev.filter((a) => a.id !== id) } };
    });
  },
  addComposerRef(convId, ref) {
    set((s) => {
      const prev = s.composerRefsByConv[convId] ?? [];
      return { composerRefsByConv: { ...s.composerRefsByConv, [convId]: [...prev, ref] } };
    });
  },
  addFileRef(convId, file) {
    get().addComposerRef(convId, {
      id: newChatRefId(),
      kind: 'file',
      quote: file.name,
      sourcePath: file.path,
    });
  },
  removeComposerRef(convId, id) {
    set((s) => {
      const prev = s.composerRefsByConv[convId] ?? [];
      return {
        composerRefsByConv: { ...s.composerRefsByConv, [convId]: prev.filter((r) => r.id !== id) },
      };
    });
  },
  clearComposerRefs(convId) {
    set((s) => ({ composerRefsByConv: { ...s.composerRefsByConv, [convId]: [] } }));
  },
  migrateComposerRefs(fromKey, toConvId) {
    set((s) => {
      const moving = s.composerRefsByConv[fromKey] ?? [];
      if (moving.length === 0) return {};
      const next = { ...s.composerRefsByConv };
      delete next[fromKey];
      next[toConvId] = [...(next[toConvId] ?? []), ...moving];
      return { composerRefsByConv: next };
    });
  },
  async send(text, attachments) {
    const trimmed = text.trim();
    const hasAttachment = !!attachments && attachments.length > 0;
    const agentId = useAgentStore.getState().activeAgentId;
    if (!agentId) {
      set({ error: i18n.t('chat:noAgent') });
      return;
    }
    const convId = useConversationStore.getState().getActiveConvId(agentId);
    if (!convId) {
      set({ error: i18n.t('chat:noConversation') });
      return;
    }

    // 把该 conv 的引用 chip 渲染成只读上下文块拼进最终文本——乐观显示与 wire 都用它，
    // 二者必须一致（否则用户看到的气泡与模型收到的内容不符）。发完即清空 refs。
    const refs = get().composerRefsByConv[convId] ?? [];
    // 仅图 / 仅引用 / 仅文都允许发；三者皆无 → 不发
    if (!trimmed && !hasAttachment && refs.length === 0) return;
    const finalText = buildMessageWithRefs(trimmed, refs);

    // Steering：本条客户端 id（服务端据此回 added/started 对齐乐观气泡）。
    // 排队标记单源：本地不预测「排队中」——排队与否只有服务端队列知道，本地 pendingByConv 是
    // 会误判的影子状态（忙碌误判 + 实际起回合时会画出撒谎的标记）。气泡照旧即时乐观显示，
    // 「排队中 + 撤回」等 chat.steering.added 广播由 handleSteeringAdded 补上。
    const clientMsgId = newMessageId();
    // 对账卡死 pending：上一回合已终态（断连丢了 chat.done）时清掉，别让输入框禁用态卡死。
    get().reconcileBusyState(convId);

    // 立刻乐观显示——本地 ChatAttachment 用 blob URL 占位（重启后 readHistory 会替换为 oru-conv-img://）
    const localAttachments = hasAttachment ? toOptimisticAttachments(attachments!) : undefined;
    get().appendUserMessage(convId, finalText, localAttachments, { clientMsgId });
    if (refs.length > 0) get().clearComposerRefs(convId);
    set((s) => ({
      pendingByConv: { ...s.pendingByConv, [convId]: true },
      lastSentByConv: {
        ...s.lastSentByConv,
        [convId]: { text: finalText, attachments: hasAttachment ? attachments! : null },
      },
      error: null,
    }));

    try {
      const wsAttachments = hasAttachment ? await toWireAttachments(attachments!) : undefined;
      await wsClient.request({
        type: 'chat.send',
        agentId,
        conversationId: convId,
        text: finalText,
        attachments: wsAttachments,
        clientMsgId,
      });
    } catch (err) {
      const message = (err as Error).message;
      set((s) => ({
        conversations: attachNetworkErrorToLast(s.conversations, convId, message),
        pendingByConv: { ...s.pendingByConv, [convId]: false },
      }));
    }
  },
  async abort(conversationId) {
    // 「能否中止」的唯一权威 = 后端流是否还开着（streamingMessageId 由 chat.started 开、
    // chat.done 关），与停止按钮的可见性同源（都由这对事件派生）。不读 pendingByConv——
    // 那是「锁输入框」的状态，借它当中止守卫正是旧 bug 的病根（显示与生效用了两套真相）。
    const msgId = get().streamingMessageIdByConv[conversationId] ?? null;
    // 睡眠唤醒恢复的「放弃此题」出口（sleep-wake-chat-recovery §6）：纯提问卡且半截无文字产出时
    // streamingMessageId 为 null（streaming 标志只在有文字产出才开），此刻仍待答卡在等、回合占着
    // 闸——若仍只认 msgId 就中止不了。补「该对话有待答卡」也放行，让放弃能释放回合（abort 到
    // backend 即 abortController.abort → waiter reject → 中断落盘）。
    const hasPendingAsk = Object.values(get().pendingAsks).some(
      (a) => a.conversationId === conversationId,
    );
    if (!msgId && !hasPendingAsk) return;
    const conv = useConversationStore.getState().byId[conversationId];
    if (!conv) return;
    const agentId = conv.agentId;
    // 本轮被用户停止：待答的提问卡 + 断路器跳闸卡置灰失效（PRD 异常情况）
    get().disablePendingAsks(conversationId);
    get().disablePendingBreaks(conversationId);
    // 乐观更新：立即给 streaming message 标 abortedByUser，让状态行立刻变灰
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      // msgId 非空≠消息一定在 list 里：loadHistory 整段替换 conversations 但不清
      // streamingMessageId，流式中撞上历史替换时这条兜底防越界。
      const idx = list.findIndex((m) => m.id === msgId);
      if (idx < 0) return s;
      const next = [...list];
      next[idx] = { ...next[idx], abortedByUser: true };
      return { conversations: { ...s.conversations, [conversationId]: next } };
    });
    try {
      const res = await wsClient.request<ChatAbortResultEvent>({
        type: 'chat.abort',
        agentId,
        conversationId,
      });
      // Esc：未消费（仍在服务端队列）的项按类型交还（G14）——用户亲手打的字回填草稿、机器触发 /
      // 渠道消息列成待处理项（applyHandback 单源分流）。
      if (res.items.length > 0) {
        get().applyHandback(conversationId, res.items);
        // 同时移除这些还没被读入的乐观「将生效」气泡（都是用户 steering，其文本已回草稿）；
        // 'withdrawing' 态留着——它在等 withdrawResult 回执，abort 不能不可逆删（不变量 3）。撤回先到
        // 服务端时该条已出队、不在 items，留住它由随后到达的 withdrawResult(removed) 正式移除，不丢。
        // 注：2026-07-28 起 steering 标记单源来自 added 广播、气泡必有 serverId，applyHandback 按
        // serverId 的移除在可达状态下已覆盖本过滤；保留它是对 serverId 漂移的双保险（代价可忽略），
        // 不再是「气泡可能没 serverId」——那个前提已随本地预测一起删除。
        set((s) => {
          const list = s.conversations[conversationId] ?? [];
          const next = list.filter((m) => !m.steering || m.steering.state === 'withdrawing');
          return { conversations: { ...s.conversations, [conversationId]: next } };
        });
      }
    } catch {
      // ws 调用失败也无所谓——UI 已经先变灰；后端的 chat.done 兜底会清 pending
    }
    // 不在这里 markDone——等 router broadcast 的 chat.done 到达，由 markDone 路径处理
  },
  async withdrawSteering(conversationId, clientMsgId) {
    const conv = useConversationStore.getState().byId[conversationId];
    if (!conv) return;
    // 乐观置「撤回中」——绝不先删（不可逆删的禁令）；删/落定等服务端回执。
    set((s) => {
      const list = s.conversations[conversationId] ?? [];
      const idx = list.findIndex((m) => m.clientMsgId === clientMsgId && m.steering);
      if (idx < 0) return s;
      const next = [...list];
      next[idx] = { ...next[idx], steering: { ...next[idx].steering!, state: 'withdrawing' } };
      return { conversations: { ...s.conversations, [conversationId]: next } };
    });
    try {
      const res = await wsClient.request<ChatSteeringWithdrawResultEvent>({
        type: 'chat.steering.withdraw',
        agentId: conv.agentId,
        conversationId,
        clientMsgId,
      });
      set((s) => {
        const list = s.conversations[conversationId] ?? [];
        const idx = list.findIndex((m) => m.clientMsgId === clientMsgId);
        if (idx < 0) return s;
        if (res.result === 'removed') {
          // 撤成：移除气泡
          return {
            conversations: {
              ...s.conversations,
              [conversationId]: list.filter((_, i) => i !== idx),
            },
          };
        }
        // alreadyConsumed：撤回晚于读入——气泡落定为已读入的普通消息（清 steering，明确反馈不静默/不闪烁）
        const next = [...list];
        next[idx] = { ...next[idx], steering: undefined };
        return { conversations: { ...s.conversations, [conversationId]: next } };
      });
    } catch {
      // ws 失败：回退「撤回中」为可撤回态，让用户能重试（绝不静默删）
      set((s) => {
        const list = s.conversations[conversationId] ?? [];
        const idx = list.findIndex((m) => m.clientMsgId === clientMsgId && m.steering);
        if (idx < 0) return s;
        const next = [...list];
        next[idx] = { ...next[idx], steering: { ...next[idx].steering!, state: 'queued' } };
        return { conversations: { ...s.conversations, [conversationId]: next } };
      });
    }
  },
  handleSteeringAdded(ev) {
    // 入队回执：把乐观「将生效」气泡对齐 serverId（idle 误判画成普通的也在此升级为将生效，避免漏标）。
    set((s) => {
      const list = s.conversations[ev.conversationId] ?? [];
      const idx = list.findIndex((m) => m.clientMsgId === ev.clientMsgId);
      if (idx < 0) {
        // 渠道排队消息（S10）：桌面没有乐观气泡（不是桌面用户打的字），据 text/origin 投影现渲染一条
        // 排队气泡。缺 origin（老语义 / 桌面消息尚未落乐观气泡的罕见时序）则忽略，同旧行为。
        if (!ev.origin || ev.text === undefined) return s;
        const bubble: ChatMessage = {
          id: ev.clientMsgId,
          conversationId: ev.conversationId,
          role: 'user',
          text: ev.text,
          toolCalls: [],
          createdAt: Date.now(),
          done: true,
          clientMsgId: ev.clientMsgId,
          steering: { state: 'queued', serverId: ev.serverId },
        };
        return { conversations: { ...s.conversations, [ev.conversationId]: [...list, bubble] } };
      }
      const next = [...list];
      const prev = next[idx];
      // 已在撤回中的不被回执打回 pending——保持撤回中等 withdrawResult 裁决
      const state = prev.steering?.state === 'withdrawing' ? 'withdrawing' : 'queued';
      next[idx] = { ...prev, steering: { state, serverId: ev.serverId } };
      return { conversations: { ...s.conversations, [ev.conversationId]: next } };
    });
  },
  handleSteeringConsumed(ev) {
    // 一批「将生效」在边界被读入：按 serverId 匹配气泡，清 steering 落定为普通消息（标记消失）。
    const ids = new Set(ev.serverIds);
    set((s) => {
      const list = s.conversations[ev.conversationId] ?? [];
      let changed = false;
      const next = list.map((m) => {
        if (m.steering?.serverId && ids.has(m.steering.serverId)) {
          changed = true;
          return { ...m, steering: undefined };
        }
        return m;
      });
      return changed ? { conversations: { ...s.conversations, [ev.conversationId]: next } } : s;
    });
  },
  handleSteeringRecovered(ev) {
    // 崩溃盘记交还：残留项按类型分流（G14）——与 Esc 退回 / 故障交还同形态。绝不自动执行。
    get().applyHandback(ev.conversationId, ev.items);
    // 送达确认后服务端才清盘记；确认失败不重试——盘记留着，下次重启再交还（宁重复不丢）
    void wsClient
      .request({
        type: 'chat.steering.recoverAck',
        agentId: ev.agentId,
        conversationId: ev.conversationId,
      })
      .catch(() => {});
  },
  handleQueueHandback(ev) {
    // 故障 / 远程刹车后队列交还：按类型分流（与 abort / 崩溃恢复同源）。
    get().applyHandback(ev.conversationId, ev.items);
  },
  applyHandback(conversationId, items) {
    const drafts = items.filter((it) => handbackForm(it) === 'draft').map((it) => it.text);
    const pending = items.filter((it) => handbackForm(it) === 'pending-item');
    set((s) => {
      const prevDraft = s.draftTextByConv[conversationId] ?? '';
      // 草稿：桌面用户亲手打的字拼在既有草稿之前、不覆盖（沿用 Esc 退回形态）。
      const mergedDraft =
        drafts.length > 0 ? [...drafts, prevDraft].filter((t) => t.length > 0).join('\n') : prevDraft;
      // 待处理项：追加、按 serverId 去重（崩溃恢复宁重复不丢，同项可能到两次）。
      const prevPending = s.pendingHandbackByConv[conversationId] ?? [];
      const seen = new Set(prevPending.map((p) => p.serverId));
      const nextPending = [...prevPending, ...pending.filter((p) => !seen.has(p.serverId))];
      // 交还项的排队气泡按 serverId 移除：交还意味着这条消息从未被 Oru 读到，其文本已回填
      // 草稿 / 待处理项，留在流里既重复显示、点撤回还会对服务端已不存在的队列项撒谎。
      // 'withdrawing' 态豁免——它在等 withdrawResult 回执，删掉会让回执无处落地（不可逆删禁令，
      // 同 abort 路径的豁免）。注意不能与 abort 的移除收敛成按 serverId 的公共 helper：abort 删的
      // 是所有非 withdrawing 的 steering 气泡（added 广播可能未到、气泡还没 serverId）。
      const handedBack = new Set(items.map((it) => it.serverId));
      const prevList = s.conversations[conversationId] ?? [];
      const nextList = prevList.filter(
        (m) =>
          !m.steering?.serverId ||
          !handedBack.has(m.steering.serverId) ||
          m.steering.state === 'withdrawing',
      );
      return {
        conversations:
          nextList.length === prevList.length
            ? s.conversations
            : { ...s.conversations, [conversationId]: nextList },
        draftTextByConv: { ...s.draftTextByConv, [conversationId]: mergedDraft },
        pendingHandbackByConv: { ...s.pendingHandbackByConv, [conversationId]: nextPending },
      };
    });
  },
  async readmitPending(conversationId, item) {
    const conv = useConversationStore.getState().byId[conversationId];
    if (!conv) return;
    // 乐观移除（放行后不再是待处理项）——绝不先删得不可逆：失败会回退放回。
    set((s) => ({
      pendingHandbackByConv: {
        ...s.pendingHandbackByConv,
        [conversationId]: (s.pendingHandbackByConv[conversationId] ?? []).filter(
          (p) => p.serverId !== item.serverId,
        ),
      },
    }));
    try {
      await wsClient.request({ type: 'chat.queue.readmit', agentId: conv.agentId, conversationId, item });
    } catch {
      // 放行失败：放回列表让用户重试（不静默丢）。
      set((s) => ({
        pendingHandbackByConv: {
          ...s.pendingHandbackByConv,
          [conversationId]: [...(s.pendingHandbackByConv[conversationId] ?? []), item],
        },
      }));
    }
  },
  dismissPending(conversationId, item) {
    set((s) => ({
      pendingHandbackByConv: {
        ...s.pendingHandbackByConv,
        [conversationId]: (s.pendingHandbackByConv[conversationId] ?? []).filter(
          (p) => p.serverId !== item.serverId,
        ),
      },
    }));
  },
  async retryLast(conversationId) {
    // [重试] 只在末条终态时可见——若 pendingByConv 仍卡 true（断连丢了 chat.done），先对账清诚实，
    // 否则下面 guard 会把这次重试静默吞掉。
    get().reconcileBusyState(conversationId);
    if (get().pendingByConv[conversationId]) return; // 正在发送中，不能再发
    const conv = useConversationStore.getState().byId[conversationId];
    if (!conv) return;
    const agentId = conv.agentId;

    // 分流（中断恢复）：末尾若是「被中断 / 出错的 assistant」→ 从该 user 回合就地重生成（chat.resume，不重发）；
    // 否则（正常完成）→ 重发上一条 user 消息（chat.send）。
    // 关键：起回合时 user 消息已先落盘，故任何中断/出错后该 user 回合都在磁盘上——重试该「就地重生成」
    // 而非重发。判据是「末条 assistant 是否中断/出错」，而非「半截有没有 token」：无产出也要 resume，
    // 否则会走 chat.send 再追加一条重复 user（历史变 user/user/assistant）。
    // 「被中断」三态都算，缺一会漏判：error=出错当场（实时态）、interrupted=中断半截落盘（重载态）、
    // abortedByUser=用户主动按停的乐观标记（实时态，空半截不落 error/interrupted 时唯一的中断依据）。
    // 判据须与 derivePhase 对 aborted 的判据（abortedByUser || interrupted）对齐——两者都是「这条
    // assistant 现在算不算已中断可续」的同一个问题，口径不一致会让「显示了 [重试] 却误走 send」。
    const list = get().conversations[conversationId] ?? [];
    const lastMsg = list[list.length - 1];
    const shouldResumeLastTurn =
      lastMsg?.role === 'assistant' &&
      (lastMsg.interrupted !== undefined || lastMsg.error !== undefined || !!lastMsg.abortedByUser);

    const lastSent = get().lastSentByConv[conversationId];
    // 既没可续的中断回合、也没上次消息可重发 → 没东西可重试
    if (!shouldResumeLastTurn && !lastSent) return;

    // retryLast 不调 appendUserMessage——避免在 errored assistant 之后再插入一条重复的 user 气泡。
    set((s) => ({
      pendingByConv: { ...s.pendingByConv, [conversationId]: true },
      error: null,
    }));

    try {
      if (shouldResumeLastTurn) {
        await wsClient.request({ type: 'chat.resume', agentId, conversationId });
      } else {
        const wsAttachments = lastSent!.attachments
          ? await toWireAttachments(lastSent!.attachments)
          : undefined;
        await wsClient.request({
          type: 'chat.send',
          agentId,
          conversationId,
          text: lastSent!.text,
          attachments: wsAttachments,
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      set((s) => ({
        conversations: attachNetworkErrorToLast(s.conversations, conversationId, message),
        pendingByConv: { ...s.pendingByConv, [conversationId]: false },
      }));
    }
  },
}));
