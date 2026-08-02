import { describe, it, expect, vi, beforeEach } from 'vitest';
/**
 * 渠道出站接线（S10 · §4 / §5）——回发解绑于回合所有权 + 提案远程语义。
 * 用真实 resolveOutboundTargets，mock deliverToChannel / clearProcessing / 提案基建。
 */
const { deliverMock, clearMock, settleMock, modeMock, transitionMock, getSettingsMock } = vi.hoisted(() => ({
  deliverMock: vi.fn(),
  clearMock: vi.fn(),
  settleMock: vi.fn(),
  modeMock: vi.fn(),
  transitionMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));
vi.mock('../../electron/main/platform/outbound', async (orig) => ({
  ...(await orig()),
  deliverToChannel: deliverMock,
}));
vi.mock('../../electron/main/platform/channelProcessing', () => ({ clearProcessing: clearMock, registerProcessing: vi.fn() }));
// 只 mock settle（要控返回值）；hasToolAwaited / forgetToolAwaited 用真实实现——留痕标记的置位与
// 释放正是本文件要验的行为，mock 掉就测不出泄漏。
vi.mock('../../electron/main/proposals/pendingDecision', async (orig) => ({
  ...(await orig()),
  settleProposalDecision: settleMock,
}));
vi.mock('../../electron/main/agent/store/agents', async (orig) => ({ ...(await orig()), realtimeApprovalModeFor: modeMock }));
vi.mock('../../electron/main/proposals/lifecycle', async (orig) => ({ ...(await orig()), transitionProposal: transitionMock }));
vi.mock('../../electron/main/projects/store', async (orig) => ({ ...(await orig()), getSettings: getSettingsMock }));

import { deliverAssistantToChannels, handleChannelProposalIfRemote } from '../../electron/main/ws/handlers/channelOutbound';
import { awaitProposalDecision, hasToolAwaited } from '../../electron/main/proposals/pendingDecision';
import type { Conversation, TriggerOrigin, Agent, ActionProposal } from '@shared/types';

/** 让某条提案带上「曾有工具在同步等」的留痕（真实置位点就是挂 waiter）。 */
function markToolAwaited(proposalId: string): void {
  void awaitProposalDecision(proposalId, new AbortController().signal);
}

const conv = { id: 'c' } as Conversation;
const agent = { id: 'a', approvalMode: 'work' } as Agent;
function origin(chatId: string, mid = 'm'): TriggerOrigin {
  return { platform: 'feishu', chatId, platformMessageId: mid };
}

beforeEach(() => {
  vi.clearAllMocks();
  deliverMock.mockResolvedValue({ ok: true });
  getSettingsMock.mockResolvedValue({ language: 'zh' });
});

describe('deliverAssistantToChannels（回发解绑回合所有权）', () => {
  it('桌面起的回合中途插入飞书消息 → 回复回发该 chat + 清该消息处理中表情', async () => {
    const o = origin('chat1');
    await deliverAssistantToChannels([{}, { origin: o }], conv, '回复内容');
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock).toHaveBeenCalledWith({ platform: 'feishu', chatId: 'chat1' }, '回复内容');
    expect(clearMock).toHaveBeenCalledWith(o); // §6 消费出站完成后清表情
  });

  it('纯桌面回合 → 不回发、无表情可清', async () => {
    await deliverAssistantToChannels([{}, {}], conv, '回复');
    expect(deliverMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
  });

  it('一个回合消费两个不同 chat → 两处都发、同 chat 去重', async () => {
    await deliverAssistantToChannels(
      [{ origin: origin('chat1', 'm1') }, { origin: origin('chat1', 'm2') }, { origin: origin('chat2') }],
      conv,
      '回复',
    );
    expect(deliverMock).toHaveBeenCalledTimes(2); // chat1 去重、chat2 各一
    // 三条消息的表情都清（按 origin 精确、含各自 platformMessageId）
    expect(clearMock).toHaveBeenCalledTimes(3);
  });
});

describe('handleChannelProposalIfRemote（提案远程语义 §5）', () => {
  const proposal = { id: 'p1', kind: 'bash' } as ActionProposal;

  it('纯桌面回合 → 返回 false（交回桌面卡），不碰提案基建', async () => {
    const handled = await handleChannelProposalIfRemote({ proposal, turnInputs: [{}], conversation: conv, agentId: 'a', agent });
    expect(handled).toBe(false);
    expect(settleMock).not.toHaveBeenCalled();
  });

  it('含渠道输入 + 同步类（settle 命中）→ 拒 + 回渠道提示，返回 true', async () => {
    settleMock.mockReturnValue(true);
    const handled = await handleChannelProposalIfRemote({
      proposal,
      turnInputs: [{ origin: origin('chat1') }],
      conversation: conv,
      agentId: 'a',
      agent,
    });
    expect(handled).toBe(true);
    expect(settleMock).toHaveBeenCalledWith('p1', 'rejected');
    expect(deliverMock).toHaveBeenCalledWith({ platform: 'feishu', chatId: 'chat1' }, expect.any(String));
  });

  it('含渠道输入 + 异步类挡位放行 → 执行、不回拒绝提示', async () => {
    settleMock.mockReturnValue(false); // 非同步类
    modeMock.mockResolvedValue('danger');
    const mcpProposal = { id: 'p2', kind: 'mcp.install' } as ActionProposal;
    const handled = await handleChannelProposalIfRemote({
      proposal: mcpProposal,
      turnInputs: [{ origin: origin('chat1') }],
      conversation: conv,
      agentId: 'a',
      agent,
    });
    expect(handled).toBe(true);
    // decidePlatformProposal(danger) → execute：不发拒绝提示
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('settle-miss 但工具等过（僵尸卡）→ 直接作废 rejected，绝不落 decidePlatformProposal（S24 §2 修正）', async () => {
    settleMock.mockReturnValue(false); // waiter 已走
    const zombie = { id: 'p_zombie', kind: 'bash' } as ActionProposal;
    markToolAwaited(zombie.id);
    const handled = await handleChannelProposalIfRemote({
      proposal: zombie,
      turnInputs: [{ origin: origin('chat1') }],
      conversation: conv,
      agentId: 'a',
      agent,
    });
    expect(handled).toBe(true);
    expect(transitionMock).toHaveBeenCalledWith(zombie, 'rejected', expect.anything());
    expect(modeMock).not.toHaveBeenCalled(); // 没进「从没人等过」的分支
    expect(deliverMock).toHaveBeenCalled(); // 回渠道提示
  });

  // 渠道就地终结的提案永不进 proposals 注册表，注册表离场那条常规清理够不着它——
  // 三条 return true 路径都必须自己释放留痕，否则 Discord 每次需审批操作漏一条。
  it('三条就地终结路径都释放留痕标记，不随触发次数增长', async () => {
    const inputs = { turnInputs: [{ origin: origin('chat1') }], conversation: conv, agentId: 'a', agent };
    for (let i = 0; i < 3; i++) {
      // 路径 1：settle 命中即拒
      settleMock.mockReturnValue(true);
      const hit = { id: `p_hit_${i}`, kind: 'bash' } as ActionProposal;
      markToolAwaited(hit.id);
      await handleChannelProposalIfRemote({ proposal: hit, ...inputs });
      expect(hasToolAwaited(hit.id)).toBe(false);

      // 路径 2：僵尸卡作废
      settleMock.mockReturnValue(false);
      const zombie = { id: `p_zombie_${i}`, kind: 'bash' } as ActionProposal;
      markToolAwaited(zombie.id);
      await handleChannelProposalIfRemote({ proposal: zombie, ...inputs });
      expect(hasToolAwaited(zombie.id)).toBe(false);

      // 路径 3：从没人等过 + 挡位不放行 → 拒绝
      modeMock.mockResolvedValue('work');
      const blocked = { id: `p_blocked_${i}`, kind: 'mcp.install', forceApproval: true } as ActionProposal;
      await handleChannelProposalIfRemote({ proposal: blocked, ...inputs });
      expect(hasToolAwaited(blocked.id)).toBe(false);
    }
  });
});

describe('handleChannelProposalIfRemote · button 能力渠道（S24 · G30 下半）', () => {
  const sendCardMock = vi.fn();
  beforeEach(async () => {
    const proj = await import('../../electron/main/platform/approvalProjection');
    proj.__resetApprovalProjectionForTest();
    sendCardMock.mockResolvedValue({ platformMessageId: 'fm_1' });
    proj.registerApprovalProjector('feishu', { capability: 'button', sendApprovalCard: sendCardMock });
  });

  it('button 渠道 → 投影可点卡、返回 false（桌面卡并存）、不 settle 不拒绝', async () => {
    const proposal = { id: 'p_btn', kind: 'bash', title: 't', description: 'rm x', grantable: [{ kind: 'destructive' }] } as ActionProposal;
    const handled = await handleChannelProposalIfRemote({
      proposal,
      turnInputs: [{ origin: origin('oc_room') }],
      conversation: conv,
      agentId: 'a',
      agent,
    });
    expect(handled).toBe(false); // 桌面卡也弹（多端并存）
    expect(sendCardMock).toHaveBeenCalledTimes(1);
    // 投影卡含 always 按钮（有 grantable）
    expect(sendCardMock.mock.calls[0]![1]).toMatchObject({ proposalId: 'p_btn', buttons: ['allow', 'always', 'reject'] });
    expect(settleMock).not.toHaveBeenCalled(); // 不 settle、不拒绝——等按钮回流
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('灾难级提案（无 grantable）→ 投影卡不带 always 按钮', async () => {
    const proposal = { id: 'p_cata', kind: 'bash', title: 't', description: 'rm -rf /' } as ActionProposal;
    await handleChannelProposalIfRemote({ proposal, turnInputs: [{ origin: origin('oc_room') }], conversation: conv, agentId: 'a', agent });
    expect(sendCardMock.mock.calls[0]![1]).toMatchObject({ buttons: ['allow', 'reject'] });
  });

  it('投影全失败 → 回落拒绝路径（不留悬空）', async () => {
    sendCardMock.mockResolvedValue(null); // 发送失败
    settleMock.mockReturnValue(true);
    const proposal = { id: 'p_fail', kind: 'bash', title: 't', description: 'x' } as ActionProposal;
    const handled = await handleChannelProposalIfRemote({ proposal, turnInputs: [{ origin: origin('oc_room') }], conversation: conv, agentId: 'a', agent });
    expect(handled).toBe(true); // 回落
    expect(settleMock).toHaveBeenCalledWith('p_fail', 'rejected');
  });
});
