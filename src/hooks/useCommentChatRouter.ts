/**
 * 把 chat.* 事件按 conversation.kind 分流到主 chatStore 或 taskboardCommentStore。
 *
 * - 评论 conv（kind='taskboard-comment'）→ taskboardCommentStore.applyChatEvent(boardTaskId, ev)
 * - 普通聊天 conv（kind='sub'）→ chatStore 现有方法
 * - byId 找不到 conv（race：chat.delta 在 commentConvCreated / loadHistory 之前到达）→
 *   buffer 2s 等元数据，超时 fallback 到主 chatStore
 *
 * App.tsx ws subscribe 把 chat.* 8 个 case 全部走本路由。
 */
import type { ServerEvent } from '@shared/protocol';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskboardCommentStore } from '@/stores/taskboardCommentStore';
import { useTaskStore } from '@/stores/taskStore';

const BUFFER_TIMEOUT_MS = 2000;

type ChatLikeEvent = Extract<
  ServerEvent,
  {
    type:
      | 'chat.started'
      | 'chat.delta'
      | 'chat.toolCall'
      | 'chat.toolResult'
      | 'chat.commandOutput'
      | 'chat.done'
      | 'chat.retrying'
      | 'chat.error'
      | 'chat.contextCompressed'
      | 'chat.memoryRecord'
      | 'chat.gitHint'
      | 'chat.scheduledTrigger'
      | 'chat.inboundUserMessage'
      | 'chat.memoryUndone'
      | 'chat.proposal'
      | 'chat.askUserChoice'
      | 'chat.circuitBreak'
      | 'chat.taskReport'
      | 'chat.proposalRecord'
      | 'chat.skillModule'
      | 'chat.subagentChip'
      | 'chat.loopCard'
      | 'chat.loopClarify';
  }
>;

function pickConvId(ev: ChatLikeEvent): string | undefined {
  if (ev.type === 'chat.taskReport') return ev.message.conversationId;
  if (ev.type === 'chat.proposalRecord') return ev.message.conversationId;
  // 其他事件都有 conversationId 字段（envelope 一致）
  return (ev as { conversationId?: string }).conversationId;
}

function dispatchToCommentStore(taskId: string, ev: ChatLikeEvent): void {
  // 评论场景永远不会触发 proposal / taskReport / memoryRecord / gitHint / memoryUndone / skillModule
  // / inboundUserMessage（评论 conv 非平台驱动）（工具被 deny + onMemoryRecord/onGitHint undefined +
  // skill 模块不在评论场景触发）；防御性丢弃
  if (
    ev.type === 'chat.proposal' ||
    ev.type === 'chat.askUserChoice' ||
    ev.type === 'chat.taskReport' ||
    ev.type === 'chat.proposalRecord' ||
    ev.type === 'chat.memoryRecord' ||
    ev.type === 'chat.gitHint' ||
    ev.type === 'chat.memoryUndone' ||
    ev.type === 'chat.skillModule' ||
    ev.type === 'chat.subagentChip' ||
    ev.type === 'chat.loopCard' ||
    ev.type === 'chat.loopClarify' ||
    ev.type === 'chat.commandOutput' ||
    ev.type === 'chat.inboundUserMessage'
  ) {
    console.warn(`[useCommentChatRouter] 评论场景收到非预期事件 ${ev.type}，丢弃`);
    return;
  }
  useTaskboardCommentStore.getState().applyChatEvent(taskId, ev);
}

function dispatchToMainChat(ev: ChatLikeEvent): void {
  // 不变量：server 流式事件只更新「已加载历史」的对话桶，绝不新建桶。投到「桌面未打开」对话的事件
  // （平台轮 / 定时任务）若新建桶，会拼出「缺历史的部分桶」，骗过 ChatArea 的空桶拉取守卫
  // （local.length>0 即跳过拉取）→ 该对话永久只剩这一轮、缺前文。建桶只许两条路：loadHistory
  // （显式拉历史）与 appendUserMessage（桌面乐观发送）。未加载的对话靠 conv.state 进列表、打开时再拉全量。
  // 例外 chat.proposal / chat.taskReport：另有 taskStore 副作用（增 / 删提案卡），不能因桶未加载而漏，放行。
  // 例外 chat.proposalRecord：与 taskStore 无关，但承载「谁准的」审批存证凭据，落进历史不能因桶未加载而漏。
  if (
    ev.type !== 'chat.proposal' &&
    ev.type !== 'chat.taskReport' &&
    ev.type !== 'chat.proposalRecord'
  ) {
    const convId = pickConvId(ev);
    if (convId && !(convId in useChatStore.getState().conversations)) return;
  }
  const cs = useChatStore.getState();
  switch (ev.type) {
    case 'chat.started':
      cs.startAssistantMessage(ev.conversationId, ev.messageId);
      break;
    case 'chat.delta':
      cs.appendDelta(ev.conversationId, ev.messageId, ev.delta);
      break;
    case 'chat.toolCall':
      cs.addToolCall(ev.conversationId, ev.messageId, ev.tool);
      break;
    case 'chat.toolResult':
      cs.updateToolResult(ev.conversationId, ev.messageId, ev.result);
      break;
    case 'chat.commandOutput':
      cs.appendCommandOutput(ev.conversationId, ev.messageId, ev.chunk);
      break;
    case 'chat.done':
      cs.markDone(ev.conversationId, ev.messageId);
      break;
    case 'chat.retrying':
      cs.handleRetrying(ev);
      break;
    case 'chat.error':
      cs.handleChatError(ev);
      break;
    case 'chat.contextCompressed':
      // 插到被压缩内容之后而非末尾（一期文档 §四），避免压缩刚发生时贴着输入框
      cs.insertContextCompressedMessage(ev.message);
      break;
    case 'chat.memoryRecord':
      cs.insertSpecialMessage(ev.message);
      break;
    case 'chat.proposalRecord':
      // 审批决定存证（S24 · G130）——kind:'proposal' 消息落进历史，同 id 去重
      cs.insertSpecialMessage(ev.message);
      break;
    case 'chat.gitHint':
      cs.insertSpecialMessage(ev.message);
      break;
    case 'chat.scheduledTrigger':
      cs.insertSpecialMessage(ev.message);
      break;
    case 'chat.inboundUserMessage':
      // 平台入站 user 消息——同 id 去重落桶（守卫已挡掉未加载对话，到这必是已打开对话）
      cs.insertSpecialMessage(ev.message);
      break;
    case 'chat.memoryUndone':
      cs.markMemoryUndone(ev.conversationId, ev.messageId);
      break;
    case 'chat.skillModule':
      cs.insertSpecialMessage(ev.message);
      break;
    case 'chat.subagentChip':
      // 对话期 Subagent chip 同 id 覆盖（运行中状态会反复 update）
      cs.upsertSubagentChip(ev.message);
      break;
    case 'chat.loopCard':
      // Loop 活动卡同 id 覆盖（编译→逐轮→收敛全程一张卡，反复 update）
      cs.upsertLoopCard(ev.message);
      break;
    case 'chat.loopClarify':
      // 拆解反问收场：反问是一条普通 assistant 消息，同 id 去重落桶
      cs.insertSpecialMessage(ev.message);
      break;
    case 'chat.proposal':
      useTaskStore.getState().addProposal(ev.proposal);
      break;
    case 'chat.askUserChoice':
      cs.addPendingAsk(ev.conversationId, ev.messageId, ev.askId, ev.questions);
      break;
    case 'chat.circuitBreak':
      cs.addPendingBreak({
        conversationId: ev.conversationId,
        messageId: ev.messageId,
        breakerId: ev.breakerId,
        reason: ev.reason,
      });
      break;
    case 'chat.taskReport': {
      // 不能用 loadHistory 追加——它会 revoke 旧列表附件的 blob URL，误杀本会话乐观发送的图片。
      // insertSpecialMessage 同 id 跳过去重、不 revoke。
      cs.insertSpecialMessage(ev.message);
      const tasksState = useTaskStore.getState();
      const proposalId = tasksState.tasks[ev.taskId]?.proposalId;
      if (proposalId) tasksState.removeProposal(proposalId);
      break;
    }
  }
}

/**
 * 单一 buffer 队列（不是每个事件独立 setTimeout）：
 *   - 多个事件先进 buffer，单条 conv 元数据到达后整个队列按入队顺序 flush
 *   - 防止 chat.delta1 / chat.delta2 走独立 retry 循环时被 setTimeout 调度乱序
 *   - 单一 flush 循环：50ms 检查一次 byId；超过 BUFFER_TIMEOUT_MS 仍未注册的事件
 *     fallback 到主 chatStore（防丢）
 */
type BufferedItem = { ev: ChatLikeEvent; convId: string; enqueuedAt: number };
const buffer: BufferedItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function dispatch(ev: ChatLikeEvent, convId: string): void {
  const conv = useConversationStore.getState().byId[convId];
  if (conv?.kind === 'taskboard-comment' && conv.boardTaskId) {
    dispatchToCommentStore(conv.boardTaskId, ev);
  } else {
    dispatchToMainChat(ev);
  }
}

function flushBuffer(): void {
  flushTimer = null;
  const now = Date.now();
  const byId = useConversationStore.getState().byId;
  // 按入队顺序遍历——一旦遇到 conv 未就绪且未超时的项就停（保证后续事件不抢跑）
  while (buffer.length > 0) {
    const item = buffer[0];
    const conv = byId[item.convId];
    if (conv) {
      buffer.shift();
      dispatch(item.ev, item.convId);
      continue;
    }
    if (now - item.enqueuedAt >= BUFFER_TIMEOUT_MS) {
      buffer.shift();
      console.warn(
        `[useCommentChatRouter] conv ${item.convId} 超过 ${BUFFER_TIMEOUT_MS}ms 仍未注册，fallback 主 chatStore`,
      );
      dispatchToMainChat(item.ev);
      continue;
    }
    // 头部事件未就绪、未超时：停止（保持后续事件等待，确保入队顺序）
    break;
  }
  if (buffer.length > 0 && !flushTimer) {
    flushTimer = setTimeout(flushBuffer, 100);
  }
}

export function routeChatEvent(ev: ChatLikeEvent): void {
  const convId = pickConvId(ev);
  if (!convId) {
    console.warn('[useCommentChatRouter] 事件缺 conversationId，丢弃:', ev.type);
    return;
  }
  // 队列非空：必须排队（即使本事件 conv 已就绪，也不能跳过排在前面未就绪的事件——保持顺序）
  if (buffer.length > 0) {
    buffer.push({ ev, convId, enqueuedAt: Date.now() });
    if (!flushTimer) flushTimer = setTimeout(flushBuffer, 50);
    return;
  }
  const conv = useConversationStore.getState().byId[convId];
  if (conv) {
    dispatch(ev, convId);
    return;
  }
  // 队列空但 conv 未就绪：入队 + 启动 flush 循环
  buffer.push({ ev, convId, enqueuedAt: Date.now() });
  if (!flushTimer) flushTimer = setTimeout(flushBuffer, 50);
}
