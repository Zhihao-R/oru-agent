/**
 * 整机睡眠唤醒恢复（文档 sleep-wake-chat-recovery）——主进程侧的「推」半。
 *
 * 监听 powerMonitor 'resume'（系统从睡眠/挂起恢复时触发——Electron 当前稳定 API 的唤醒事件，
 * 旧别名 'wake' 类型未收录）：唤醒时刻主进程是唯一记住在途上下文的一方
 * （steeringQueue.running / waiter / runner 内存 partial 全在主进程），此刻主动算出哪些对话
 * 有在途状态，broadcast 一个 `chat.wakeRecover`（携带 conversationIds）给渲染层。渲染层收到
 * 后对所列每个对话发 `chat.pendingTurnState.query` 拉真相快照对账。
 *
 * 与渲染层 mount 兜底拉互补（推+拉双保险，见文档「触发必须推+拉」）：wake 推覆盖「睡眠+唤醒
 * 全程窗口开着」；mount 拉覆盖「窗口已关→重开」。
 *
 * powerMonitor 需在 app.whenReady 后可用；监听随本模块生命周期注册/清理（副作用生命周期约定）。
 */
import { powerMonitor } from 'electron';
import type { Broadcast } from './server';
import { steeringQueue } from '../agent/steeringQueue';
import { listPendingWaiterConvs } from '../proposals/pendingUserChoice';

/**
 * 唤醒时算「哪些对话在途」：两个信号都算——
 * 1. steeringQueue running=true 的对话（回合占着闸正在跑 / 卡在等用户）——key 带 agentId；
 * 2. 有活 waiter 的对话（提问卡还在等回答）——agentId + conversationId 成对。
 * 双方都算，Set 去重（同一对话可能同时命中两者）。
 */
export function computeInFlightConversations(): { agentId: string; conversationId: string }[] {
  const seen = new Set<string>();
  const out: { agentId: string; conversationId: string }[] = [];
  const push = (agentId: string, conversationId: string): void => {
    const k = `${agentId}:${conversationId}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ agentId, conversationId });
  };
  for (const key of steeringQueue.listRunningKeys()) {
    const sep = key.indexOf(':');
    if (sep < 0) continue;
    push(key.slice(0, sep), key.slice(sep + 1));
  }
  for (const c of listPendingWaiterConvs()) push(c.agentId, c.conversationId);
  return out;
}

/**
 * 唤醒时主动推给渲染层：广播 `chat.wakeRecover`（conversationIds）。无在途对话则不推。
 * 返回是否真的广播了——单测可据此断言。
 */
export function broadcastWakeRecovery(broadcast: Broadcast): boolean {
  const convs = computeInFlightConversations();
  if (convs.length === 0) return false;
  broadcast({ type: 'chat.wakeRecover', conversationIds: convs.map((c) => c.conversationId) });
  return true;
}

let disposed = false;
let unlisten: (() => void) | null = null;

export function startWakeRecovery(broadcast: Broadcast): void {
  if (disposed || unlisten) return;
  const onWake = (): void => {
    if (disposed) return;
    try {
      broadcastWakeRecovery(broadcast);
    } catch (e) {
      console.warn('[wakeRecovery] 唤醒对账推送失败:', e);
    }
  };
  powerMonitor.on('resume', onWake);
  unlisten = () => powerMonitor.removeListener('resume', onWake);
}

export function disposeWakeRecovery(): void {
  disposed = true;
  unlisten?.();
  unlisten = null;
}

/** 单测/重启探活用：重置 disposed + 卸载监听（既可重挂，也让测试不残留跨用例监听）。 */
export function resetWakeRecovery(): void {
  disposeWakeRecovery();
  disposed = false;
}
