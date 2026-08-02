/**
 * 睡眠唤醒恢复·主进程侧（sleep-wake-chat-recovery）——computeInFlightConversations / broadcastWakeRecovery 单测：
 *  - running 对话（steeringQueue 占闸）被列为在途
 *  - 有 waiter 在等回答的对话被列为在途（即使回合已释放闸）
 *  - 同一对话同时命中两者 → 去重
 *  - 无在途时 broadcastWakeRecovery 返回 false、不发广播
 *  - 有在途时返回 true 并广播 chat.wakeRecover（conversationIds）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';
import { awaitUserChoice, settleUserChoice } from '../../electron/main/proposals/pendingUserChoice';
import {
  computeInFlightConversations,
  broadcastWakeRecovery,
} from '../../electron/main/ws/wakeRecovery';

const q = (header: string) => ({ question: `${header}？`, header, options: [{ label: 'A' }] });
const ans = (label: string) => ({ answers: [{ questionIndex: 0, selectedLabels: [label] }] });

afterEach(async () => {
  // 结束时清掉可能残留的 running：handBackIfRunning 按 token 释放闸（token 用 runToken 取）
  for (const key of steeringQueue.listRunningKeys()) {
    await steeringQueue.handBackIfRunning(key, steeringQueue.runToken(key));
  }
});

describe('sleep-wake·computeInFlightConversations', () => {
  it('running 对话（占闸）被列为在途', async () => {
    const key = steeringKey('twin', 'conv_run');
    const token = await steeringQueue.beginDirectTurn(key);
    expect(token).not.toBeNull();

    const convs = computeInFlightConversations();
    expect(convs).toContainEqual({ agentId: 'twin', conversationId: 'conv_run' });
  });

  it('有 waiter 的对话被列为在途（回合闸已释放也不漏）', async () => {
    const sig = new AbortController().signal;
    const p = awaitUserChoice('twin', 'conv_waiter', 'ask_wl', [q('WAIT')], sig);

    const convs = computeInFlightConversations();
    expect(convs).toContainEqual({ agentId: 'twin', conversationId: 'conv_waiter' });

    // cleanup
    settleUserChoice('ask_wl', ans('x'));
    await p.catch(() => {});
  });

  it('同一对话同时 running + 有 waiter → 只算一份', async () => {
    const key = steeringKey('twin', 'conv_both');
    await steeringQueue.beginDirectTurn(key);
    const sig = new AbortController().signal;
    const p = awaitUserChoice('twin', 'conv_both', 'ask_both', [q('B')], sig);

    const convs = computeInFlightConversations();
    expect(convs.filter((c) => c.conversationId === 'conv_both')).toHaveLength(1);

    settleUserChoice('ask_both', ans('x'));
    await p.catch(() => {});
  });

  it('无在途 → 空列表', () => {
    expect(computeInFlightConversations()).toEqual([]);
  });
});

describe('sleep-wake·broadcastWakeRecovery', () => {
  it('无在途 → 返回 false、不发广播', () => {
    const spy = vi.fn();
    expect(broadcastWakeRecovery(spy)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('有在途 → 返回 true、广播 chat.wakeRecover 携带 conversationIds', async () => {
    const key = steeringKey('twin', 'conv_bc');
    await steeringQueue.beginDirectTurn(key);

    const spy = vi.fn();
    expect(broadcastWakeRecovery(spy)).toBe(true);
    expect(spy).toHaveBeenCalledWith({
      type: 'chat.wakeRecover',
      conversationIds: ['conv_bc'],
    });
  });
});
