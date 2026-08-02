/**
 * pendingUserChoice 信箱单测——验技术设计 §4 的承重修正 + 睡眠唤醒对账（sleep-wake-chat-recovery）：
 *  - 并发两个 ask（不同 askId）各自 resolve、互不覆盖（按 askId 挂、非 conversationId）
 *  - settle 未知 / 已答的 askId → false（重复提交安全）
 *  - abort signal → reject + 后续 settle 落空（不留死 deferred）
 *  - 注册前已 abort 的 signal → 立即 reject
 *  - 唤醒对账：waiter 携带 agentId/conversationId/questions；listPendingAsksForConversation
 *    只返回仍在等、属于该 agent+conversation 的卡；settle/abort 后查不到
 *  - listPendingWaiterConvs 枚举去重
 */
import { describe, it, expect } from 'vitest';
import {
  awaitUserChoice,
  settleUserChoice,
  listPendingAsksForConversation,
  listPendingWaiterConvs,
} from '../../electron/main/proposals/pendingUserChoice';

const ans = (label: string) => ({ answers: [{ questionIndex: 0, selectedLabels: [label] }] });
const q = (header: string) => ({ question: `${header}问题`, header, options: [{ label: 'A' }] });

describe('pendingUserChoice', () => {
  it('并发两个 askId 各自 resolve，互不覆盖', async () => {
    const sig = new AbortController().signal;
    const p1 = awaitUserChoice('agent', 'conv_1', 'ask_1', [q('Q1')], sig);
    const p2 = awaitUserChoice('agent', 'conv_2', 'ask_2', [q('Q2')], sig);

    // 故意乱序 settle，验证按 askId 精确命中
    expect(settleUserChoice('ask_2', ans('B'))).toBe(true);
    expect(settleUserChoice('ask_1', ans('A'))).toBe(true);

    await expect(p1).resolves.toEqual(ans('A'));
    await expect(p2).resolves.toEqual(ans('B'));
  });

  it('settle 未知 askId → false', () => {
    expect(settleUserChoice('ask_nope', ans('x'))).toBe(false);
  });

  it('已 resolve 的 askId 重复 settle → false', async () => {
    const sig = new AbortController().signal;
    const p = awaitUserChoice('agent', 'conv_1', 'ask_dup', [q('Q')], sig);
    expect(settleUserChoice('ask_dup', ans('A'))).toBe(true);
    await p;
    expect(settleUserChoice('ask_dup', ans('A'))).toBe(false);
  });

  it('abort → reject，且后续 settle 落空', async () => {
    const ac = new AbortController();
    const p = awaitUserChoice('agent', 'conv_1', 'ask_abort', [q('Q')], ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(settleUserChoice('ask_abort', ans('A'))).toBe(false);
  });

  it('注册前已 abort 的 signal → 立即 reject', async () => {
    await expect(
      awaitUserChoice('agent', 'conv_1', 'ask_pre', [q('Q')], AbortSignal.abort()),
    ).rejects.toThrow();
  });
});

describe('pendingUserChoice·睡眠唤醒对账', () => {
  it('listPendingAsksForConversation 只返回属于该 agent+conversation 仍在等的卡', async () => {
    const sig = new AbortController().signal;
    const p1 = awaitUserChoice('agent', 'conv_a', 'ask_ca1', [q('CA1')], sig);
    const p2 = awaitUserChoice('agent', 'conv_a', 'ask_ca2', [q('CA2')], sig);
    // 另一个对话同 agent
    const p3 = awaitUserChoice('agent', 'conv_b', 'ask_cb', [q('CB')], sig);
    // 另一个 agent 同 convId（隔离性：不同 agent 的 waiter 不混）
    const p4 = awaitUserChoice('agent2', 'conv_a', 'ask_oc', [q('OC')], sig);

    const convA = listPendingAsksForConversation('agent', 'conv_a');
    expect(convA.map((x) => x.askId).sort()).toEqual(['ask_ca1', 'ask_ca2']);
    expect(convA[0].questions).toEqual([q('CA1')]);

    expect(listPendingAsksForConversation('agent', 'conv_b').map((x) => x.askId)).toEqual([
      'ask_cb',
    ]);
    // agent2 的 waiter 不该被 agent 的查询捞到
    expect(listPendingAsksForConversation('agent', 'conv_a').some((x) => x.askId === 'ask_oc')).toBe(
      false,
    );

    // 清理：settle 掉避免测试残留
    settleUserChoice('ask_ca1', ans('1'));
    settleUserChoice('ask_ca2', ans('2'));
    settleUserChoice('ask_cb', ans('3'));
    settleUserChoice('ask_oc', ans('4'));
    await Promise.all([p1, p2, p3, p4].map((p) => p.catch(() => {})));
  });

  it('settle 后该卡从对账列表消失', async () => {
    const sig = new AbortController().signal;
    const p = awaitUserChoice('agent', 'conv_s', 'ask_settle', [q('S')], sig);
    expect(listPendingAsksForConversation('agent', 'conv_s').map((x) => x.askId)).toEqual([
      'ask_settle',
    ]);
    expect(settleUserChoice('ask_settle', ans('S'))).toBe(true);
    await p;
    expect(listPendingAsksForConversation('agent', 'conv_s')).toEqual([]);
  });

  it('abort 后该卡从对账列表消失', async () => {
    const ac = new AbortController();
    const p = awaitUserChoice('agent', 'conv_ab', 'ask_ab2', [q('A')], ac.signal);
    expect(listPendingAsksForConversation('agent', 'conv_ab').map((x) => x.askId)).toEqual([
      'ask_ab2',
    ]);
    ac.abort();
    await expect(p).rejects.toThrow();
    expect(listPendingAsksForConversation('agent', 'conv_ab')).toEqual([]);
  });

  it('listPendingWaiterConvs 枚举在等对话并按 agent+conv 去重', async () => {
    const sig = new AbortController().signal;
    const p1 = awaitUserChoice('agent', 'conv_w1', 'ask_w1a', [q('W1')], sig);
    const p2 = awaitUserChoice('agent', 'conv_w1', 'ask_w1b', [q('W1b')], sig); // 同 conv 两个卡 → 去重
    const p3 = awaitUserChoice('agent', 'conv_w2', 'ask_w2', [q('W2')], sig);

    const convs = listPendingWaiterConvs();
    expect(convs).toContainEqual({ agentId: 'agent', conversationId: 'conv_w1' });
    expect(convs).toContainEqual({ agentId: 'agent', conversationId: 'conv_w2' });
    // conv_w1 因两个卡只出一份
    expect(convs.filter((c) => c.conversationId === 'conv_w1')).toHaveLength(1);

    settleUserChoice('ask_w1a', ans('1'));
    settleUserChoice('ask_w1b', ans('2'));
    settleUserChoice('ask_w2', ans('3'));
    await Promise.all([p1, p2, p3].map((p) => p.catch(() => {})));
  });
});
