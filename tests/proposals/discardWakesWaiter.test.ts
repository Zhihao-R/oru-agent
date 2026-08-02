/**
 * 「算了」吊死回合回归——走查二批该修 2（2026-08-01 方案）。
 *
 * 病灶：审批卡点「算了」走 proposal.discard → discardProposal 只删 Map 与旁路登记，
 * 不兑现同步等待审批决定的工具 waiter（pendingDecision.awaitProposalDecision）——
 * turn 永远停在工具等待点：UI 永挂「正在调用」、模型视野里 tool_use 无 tool_result、
 * turn-inflight 残留 running。LRU 淘汰同走 forgetProposalSideChannels，踩一模一样的挂死。
 * 防线：注册表离场时先 abortProposalDecision 兑现等待者（'aborted'），两条泄漏路一处封死。
 */
import { describe, it, expect } from 'vitest';
import type { CodeActionProposal } from '@shared/types';
import {
  rememberProposal,
  discardProposal,
  getProposal,
} from '../../electron/main/proposals/registry';
import {
  awaitProposalDecision,
  hasToolAwaited,
} from '../../electron/main/proposals/pendingDecision';

let seq = 0;
function makeProposal(id?: string): CodeActionProposal {
  return {
    id: id ?? `prop_discard_${seq++}`,
    ownerId: 'local-user',
    conversationId: 'conv_discard',
    title: '测试提案',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    kind: 'code',
    targetProjectId: 'proj_discard',
    risk: 'low',
    rollbackable: true,
    rawPlan: '测试计划',
  } satisfies CodeActionProposal;
}

describe('discard / LRU 离场兑现同步等待的工具（该修 2）', () => {
  it('discard 一张有工具在等的 pending 卡：waiter 以 aborted 兑现，不吊死', async () => {
    const p = makeProposal();
    rememberProposal(p);
    const decisionPromise = awaitProposalDecision(p.id, new AbortController().signal);
    expect(hasToolAwaited(p.id)).toBe(true);

    discardProposal(p.id);

    await expect(decisionPromise).resolves.toBe('aborted');
    expect(getProposal(p.id)).toBeUndefined();
    expect(hasToolAwaited(p.id)).toBe(false); // 留痕标记随离场清掉
  });

  it('discard 无 waiter 的卡：不抛错（abortProposalDecision 幂等 no-op）', () => {
    const p = makeProposal();
    rememberProposal(p);
    expect(() => discardProposal(p.id)).not.toThrow();
    expect(getProposal(p.id)).toBeUndefined();
  });

  it('LRU 淘汰有工具在等的 pending 卡：waiter 同样以 aborted 兑现', async () => {
    const victim = makeProposal('prop_lru_victim');
    rememberProposal(victim);
    const decisionPromise = awaitProposalDecision(victim.id, new AbortController().signal);

    // 塞满 100 上限再入一条 → victim（最早）被淘汰，走与 discard 同一清理路径
    for (let i = 0; i < 100; i++) rememberProposal(makeProposal());

    await expect(decisionPromise).resolves.toBe('aborted');
    expect(getProposal(victim.id)).toBeUndefined();
  });
});
