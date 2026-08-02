/**
 * 远程审批卡：投影卡渲染 + 按钮回流门卫（S24 · G30 下半）。
 *
 * 门卫是安全承重：card.action 只认绑定主人本人的平台身份（复用消息入站白名单），
 * 非本人静默丢弃、绝不 settle。本人点击才汇入 settleApprovalDecision（by=channel）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlatformAdapter } from '../../electron/main/platform/adapter';
import type { ApprovalCallbackEvent, SessionSource } from '@shared/platform/message';

const settleMock = vi.hoisted(() => vi.fn(async () => ({ status: 'settled' as const })));
vi.mock('../../electron/main/ws/handlers/settleApprovalDecision', () => ({
  settleApprovalDecision: settleMock,
}));

import { createPlatformGateway } from '../../electron/main/platform/gatewayWiring';
import { buildFeishuApprovalCard, buildFeishuTerminalCard } from '../../electron/main/platform/feishu/approvalCard';

const OWNER = 'ou_owner';

function fakeAdapter(capture: { cb?: (e: ApprovalCallbackEvent) => Promise<void> }): PlatformAdapter {
  return {
    platform: 'feishu',
    maxMessageLength: 8000,
    maxFileBytes: 1,
    approvalCapability: 'button',
    connect: async () => true,
    disconnect: async () => {},
    send: async () => ({ ok: true }),
    setApprovalCallback: (cb) => {
      capture.cb = cb;
    },
  } satisfies PlatformAdapter;
}

function source(userId: string): SessionSource {
  return { platform: 'feishu', chatId: 'oc_1', chatType: 'dm', userId, raw: {} };
}

describe('approval card 门卫回流', () => {
  beforeEach(() => settleMock.mockClear());

  function wire(whitelist: string[]) {
    const cap: { cb?: (e: ApprovalCallbackEvent) => Promise<void> } = {};
    createPlatformGateway(fakeAdapter(cap), {
      pairing: { issue: () => ({ code: 'x', expiresAt: 0 }), tryConsume: () => false } as never,
      loadWhitelist: async () => whitelist.map((id) => ({ id })),
      addToWhitelist: async () => {},
      resolveRemoteAgentId: async () => 'twin',
    });
    return cap;
  }

  it('本人点「始终允许」→ settleApprovalDecision(approved, always, by=channel)', async () => {
    const cap = wire([OWNER]);
    await cap.cb!({ proposalId: 'p1', action: 'always', source: source(OWNER) });
    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(settleMock.mock.calls[0]![0]).toMatchObject({
      proposalId: 'p1',
      decision: 'approved',
      always: true,
      by: { source: 'channel', platform: 'feishu', userId: OWNER },
    });
  });

  it('本人点「拒绝」→ decision=rejected, always=false', async () => {
    const cap = wire([OWNER]);
    await cap.cb!({ proposalId: 'p2', action: 'reject', source: source(OWNER) });
    expect(settleMock.mock.calls[0]![0]).toMatchObject({ decision: 'rejected', always: false });
  });

  it('非本人点击 → 静默丢弃，绝不 settle（fail-closed）', async () => {
    const cap = wire([OWNER]);
    await cap.cb!({ proposalId: 'p3', action: 'allow', source: source('ou_attacker') });
    expect(settleMock).not.toHaveBeenCalled();
  });
});

describe('飞书投影卡渲染', () => {
  it('有 grantable（always 按钮）→ 三按钮，reject 为 danger', () => {
    const card = buildFeishuApprovalCard(
      { proposalId: 'p', title: 'T', body: 'B', buttons: ['allow', 'always', 'reject'] },
      'zh',
    ) as { elements: Array<{ tag: string; actions?: Array<{ type: string; value: unknown }> }> };
    const action = card.elements.find((e) => e.tag === 'action')!;
    expect(action.actions).toHaveLength(3);
    expect(action.actions!.map((a) => a.value)).toEqual([
      { proposalId: 'p', action: 'allow' },
      { proposalId: 'p', action: 'always' },
      { proposalId: 'p', action: 'reject' },
    ]);
    expect(action.actions![2]!.type).toBe('danger'); // reject
  });

  it('终态卡无按钮', () => {
    const card = buildFeishuTerminalCard('approved', 'zh') as { elements: Array<{ tag: string }> };
    expect(card.elements.some((e) => e.tag === 'action')).toBe(false);
  });
});
