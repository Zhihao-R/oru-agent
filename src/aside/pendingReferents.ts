/**
 * 随手评点的 pending 指代队列——短聊流式轮中再 ⌥ 点的指认先排在这里，
 * 轮结束后按点击顺序逐张发 aside.addReferent（卡序 = 点击序）。
 *
 * 为什么逐张、不"多张一次合并回应"：主进程 addReferent 落卡即起一轮回合
 * （router 没有"只落卡不起轮"的形态），所以 flush 一次只放队首一张——
 * 它起的那轮结束后订阅再触发，放下一张。每张卡各得一轮回应。
 *
 * 队列驻模块级内存、订阅也挂在模块级：flush 与浮层开关 / promote 完全解耦——
 * ⌥ 点一经做出就属于这场对话，关浮层 / 转正都不让指认蒸发（promote 后 conv
 * 已是 sub，addReferent 经 buildMainChatTurnArgs 按 kind 自动拿到正确形态）。
 * 流式轮期间应用退出会丢未 flush 的指认——接受的边界，不为它建持久化。
 *
 * 订阅生命周期与队列非空成对：第一张入队时挂 chatStore 订阅，队列清空即摘——
 * 注册与清理同处可见（项目副作用纪律）。
 */
import type { AsideAddReferentResultEvent } from '@shared/protocol';
import type { AsideReferent } from '@shared/types';
import { ErrorCodes } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { useChatStore } from '@/stores/chatStore';
import { asideOriginField } from './origin';

export type PendingAsideReferent = {
  agentId: string;
  conversationId: string;
  referent: AsideReferent;
  /** 已画标记的截图 PNG base64（不带 data: 前缀）；截图失败则缺省 */
  screenshot?: string;
};

const queue: PendingAsideReferent[] = [];
let unsubscribe: (() => void) | null = null;
let flushing = false;

function teardownIfEmpty(): void {
  if (queue.length === 0 && unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

/**
 * 入队 + 立即尝试 flush：没有流式轮在跑时等价于"直接发"，有则等轮结束——
 * 两条路径统一经队列走，连点时顺序天然成立。
 */
export function enqueueAsideReferent(item: PendingAsideReferent): void {
  queue.push(item);
  if (!unsubscribe) {
    // 流式结束信号：该 conv 的 streamingMessageId 由非空转空（chat.done / chat.error 都经
    // markDone 这条路收口）。只盯队首的 conv——队列按序消化，队首没走后面不动。
    unsubscribe = useChatStore.subscribe((s, prev) => {
      const head = queue[0];
      if (!head) return;
      const id = head.conversationId;
      if (prev.streamingMessageIdByConv[id] && !s.streamingMessageIdByConv[id]) {
        void flushAsideReferents();
      }
    });
  }
  void flushAsideReferents();
}

/** flush 队首一张；该卡起的回合结束后由订阅触发下一张 */
export async function flushAsideReferents(): Promise<void> {
  if (flushing) return;
  const head = queue[0];
  if (!head) return;
  // 流式中：不发（主进程忙时不落盘会回 AGENT_BUSY），等轮结束的订阅触发
  if (useChatStore.getState().streamingMessageIdByConv[head.conversationId]) return;
  flushing = true;
  const item = queue.shift()!;
  let discarded = false;
  try {
    const res = await wsClient.request<AsideAddReferentResultEvent>({
      type: 'aside.addReferent',
      agentId: item.agentId,
      conversationId: item.conversationId,
      referent: item.referent,
      screenshot: item.screenshot,
      ...asideOriginField(),
    });
    // 指代卡回流灌桶（与 begin 的种子灌桶同一哲学：桶 = 落盘历史）——浮层立即可见
    // 这张卡，promote 后 ChatArea（桶非空不拉历史）开头完整。主进程先 reply 本结果
    // 再广播 chat.started，同一条 ws 顺序送达，卡必然排在本轮 assistant 回应之前。
    useChatStore.getState().insertSpecialMessage(res.message);
  } catch (err) {
    if ((err as { code?: string }).code === ErrorCodes.AGENT_BUSY) {
      // 撞上恰好同时开口的一轮（主进程忙锁）：重新入队首，下一轮结束再试
      queue.unshift(item);
    } else {
      // 网络类失败与短评同一克制口径：静默丢弃，不建重试管线
      console.warn('[aside] 指代卡发送失败，丢弃：', (err as Error).message);
      discarded = true;
    }
  } finally {
    flushing = false;
    teardownIfEmpty();
  }
  // 丢弃的卡没起回合，"轮结束"信号不会来——主动放行下一张（flushing 已复位）
  if (discarded) void flushAsideReferents();
}

/** 仅测试用：清空队列并摘订阅 */
export function resetAsideReferentQueueForTest(): void {
  queue.length = 0;
  flushing = false;
  teardownIfEmpty();
}
