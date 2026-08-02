/**
 * 连发撤起的入口编排（S1 三态之 busy-restartIfClean，chat.send / 渠道 admit / queue.readmit 共用）。
 *
 * 与被 mock 的装配内核（mainTurnAssembly.runAssembledMainTurn）分文件：入口编排经 import 引用
 * 装配，测试替换装配时本模块跟着拿到替身（同文件自引用绕不过 vi.mock）。
 */
import type { Agent, ChatAttachment, ChatMessage, Conversation, TriggerOrigin } from '@shared/types';
import { newMessageId } from '@shared/ids';
import type { Broadcast } from '../server';
import { appendMessage } from '../../conversations/store';
import { abortConversation } from '../../agent/runner';
import { steeringQueue, steeringKey } from '../../agent/steeringQueue';
import { drainLiveTurn, supersedeLiveTurn } from '../../agent/liveTurnMark';
import { clearProcessingForItems } from '../../platform/channelProcessing';
import { runAssembledMainTurn } from './mainTurnAssembly';

/**
 * 连发撤起的同步段（S1 三态之 busy-restartIfClean 的入口编排第一半，chat.send / 渠道 admit 共用）。
 *
 * **必须在 restart 决策返回后的首个 await 前同步调用**（仓规：副作用与判定同处可见）——
 * 决策到杀之间只隔微任务，网络宏任务插不进来，保证「判定干净 → 杀」之间不会有 delta 溜出
 * （溜出一个 delta，撤起就不再无痕迹：被撤回合会落一条半截 incomplete bubble）。
 *
 * 两件事：杀在飞 LLM 请求（无产出即无半截落盘、无 chat.error——与 Esc 抢跑同形静默）+
 * custody 过户给新 token（被撤回合的迟到收尾凭旧 token 动不到新条；新消息 origin 就地入账）。
 */
export function supersedeCleanTurn(
  agentId: string,
  conversationId: string,
  newRunToken: number,
  newOrigin?: TriggerOrigin,
): void {
  abortConversation(agentId, conversationId);
  supersedeLiveTurn(steeringKey(agentId, conversationId), newRunToken, newOrigin);
}

/**
 * 连发撤起的异步段（入口编排第二半）：新消息落盘为正式历史 + 起新装配。
 * 与 /stop 的 brake 语义不同（承重口径 1）：被撤回合已消费的 origins 不经 handback——
 * 它们随 custody 进重起回合的 turnInputs（表情逐条清、回发照旧）；排队项原地不动，
 * 由新回合的 drain / conclude 照常消费。落盘失败按 §6 token 归属释闸后上抛（回执归调用方）。
 */
export async function restartCleanMainTurn(args: {
  agentId: string;
  agent: Agent;
  conversation: Conversation;
  broadcast: Broadcast;
  /** restart 决策给出的新 token（supersedeCleanTurn 已同步过户）。 */
  runToken: number;
  clientMsgId: string;
  text: string;
  attachments?: ChatAttachment[];
  /** 新消息的渠道 origin（桌面无）；supersedeCleanTurn 已入账 custody，这里只作首轮 firstOrigin。 */
  origin?: TriggerOrigin;
  extraDynamicSystemPrompt?: string;
  /** 落盘后、起装配前（渠道入口补广播 chat.inboundUserMessage / notifyConvChanged）。 */
  onPersisted?: (msg: ChatMessage) => void;
}): Promise<void> {
  const { agentId, agent, conversation, broadcast, runToken, clientMsgId, text, attachments, origin, extraDynamicSystemPrompt, onPersisted } = args;
  const userMsg: ChatMessage = {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'user',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    clientMsgId,
    ...(attachments ? { attachments } : {}),
  };
  try {
    await appendMessage(agentId, conversation.id, userMsg);
  } catch (e) {
    // 落盘失败必须释放刚翻新的闸（否则对话永久卡「运行中」）——按 token 归属释放（§6），
    // 不误清 await 间隙里可能已起的新回合（连发第 3 条的又一次撤起）。
    const released = await steeringQueue.handBackIfRunning(steeringKey(agentId, conversation.id), runToken);
    // custody 兜底（S1 review · I2）：闸真释放到手（新回合永不起跑）时，custody 里的渠道
    // origin 无人交付——销条 + 清「处理中」表情，防永久悬挂。token 失配（闸已被第 3 条连撤
    // 接手）则 custody 归新回合所有，不得销它的条。
    if (released !== null) {
      clearProcessingForItems(drainLiveTurn(steeringKey(agentId, conversation.id)).map((origin) => ({ origin })));
    }
    throw e;
  }
  onPersisted?.(userMsg);
  void runAssembledMainTurn({
    agentId,
    agent,
    conversation,
    broadcast,
    runToken,
    firstText: text,
    attachments,
    firstOrigin: origin,
    extraDynamicSystemPrompt,
  });
}
