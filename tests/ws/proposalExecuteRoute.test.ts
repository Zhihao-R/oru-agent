/**
 * 假已执行回归——router 本体集成版（病灶在 router，防线架在 router）：
 * 经真 route({type:'proposal.execute'}) 驱动同步审批路径，断言批准瞬间广播的是
 * executing 而非 executed（旧实现正是在这里抢答 executed）；工具执行完成后
 * 终态经 finalizer 回报为 executed/failed。
 *
 * finalize.test.ts 验的是 emitProposal↔pendingDecision 协作；本文件把 router 的
 * 注册 finalizer→settle→transition('executing') 真实代码路径纳入断言——
 * 若有人把 route 里的 'executing' 改回 'executed'，此测试直接红。
 *
 * 时序：proposeOrExecute 先同步挂 waiter（awaitProposalDecision）再 await onProposal（见
 * emitProposal.ts:93-95）——故「onProposal 已被调用」即「waiter 已就位、异步前奏跑完」的确定性
 * 信号。改用它等待，取代旧的 `await sleep(20)` 固定睡眠（全量并行负载下 20ms 不够、route 抢在
 * waiter 注册前跑 → 误判僵尸卡 rejected，是本文件历史偶发 flake 的根因）。
 */
import { describe, expect, it } from 'vitest';
import { route } from '../../electron/main/ws/router';
import { rememberProposal } from '../../electron/main/proposals/registry';
import { proposeOrExecute } from '../../electron/main/agent/agentTools/emitProposal';
import type { ToolContext } from '@shared/agent/backend';
import type { BashProposal } from '@shared/types';
import { makeToolContext } from '../helpers/toolContext';
import { captureBroadcast } from '../helpers/broadcast';

let seq = 0;
function makeProposal(): BashProposal {
  return {
    id: `prop_route_${seq++}`,
    ownerId: 'local-user',
    conversationId: 'conv_route',
    title: '跑命令',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    kind: 'bash',
    command: 'echo hi',
    isDestructive: false,
    isReadOnly: false,
    segments: [{ text: 'echo hi', destructive: false }],
    // forceApproval 让 work 挡也走审批流（只读重构后挡位不再"什么都问"）；本文件测 router 审批终态链。
    forceApproval: true,
  } satisfies BashProposal;
}

// agent_1 在磁盘不存在 → realtimeApprovalMode 回落到 ctx.approvalMode（work）
const makeCtx = (onProposal: ToolContext['onProposal']): ToolContext =>
  makeToolContext({ conversationId: 'conv_route', agentId: 'agent_1', usage: 'chat', onProposal });

/** onProposal 被调用即 resolve——「waiter 已注册」的确定性信号，替代固定 sleep。 */
function proposalEmitted() {
  let fire!: () => void;
  const emitted = new Promise<void>((r) => (fire = r));
  return { emitted, onProposal: async () => fire() };
}

describe('route(proposal.execute) 同步审批路径', () => {
  it('批准瞬间只广播 executing（不抢答 executed）；工具完成后才 executed', async () => {
    const p = makeProposal();
    rememberProposal(p);
    const cap = captureBroadcast();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { emitted, onProposal } = proposalEmitted();

    const running = proposeOrExecute(makeCtx(onProposal), p, {
      approvalText: '等审批',
      execute: async () => {
        await gate;
        return { text: 'ok' };
      },
    });
    await emitted; // waiter 已注册（proposeOrExecute 先挂 waiter 再 await onProposal）

    await route({ type: 'proposal.execute', reqId: 'r1', proposalId: p.id }, () => {}, cap.broadcast);
    // route 返回时工具还卡在 execute——绝不能已是终态（假已执行的病灶）
    expect(cap.statuses()).toEqual(['executing']);

    release();
    await expect(running).resolves.toEqual({ text: 'ok' });
    expect(cap.statuses()).toEqual(['executing', 'executed']);
  });

  it('工具执行失败：终态广播 failed（带错因），不是 executed', async () => {
    const p = makeProposal();
    rememberProposal(p);
    const cap = captureBroadcast();
    const { emitted, onProposal } = proposalEmitted();

    const running = proposeOrExecute(makeCtx(onProposal), p, {
      approvalText: '等审批',
      execute: async () => {
        throw new Error('落盘失败');
      },
    });
    await emitted;

    await route({ type: 'proposal.execute', reqId: 'r2', proposalId: p.id }, () => {}, cap.broadcast);
    await expect(running).rejects.toThrow('落盘失败');
    expect(cap.statuses()).toEqual(['executing', 'failed']);
    expect(p.failureMessage).toBe('落盘失败');
  });

  // 僵尸卡的判据是「曾有工具在等、但它走了」（hasToolAwaited），不是 kind——故用例必须真的
  // 让工具先起卡再 abort 走人。裸造一张从没人等过的卡是「设置页起卡」形态，走的是另一条分支。
  it('僵尸卡（工具起卡后 abort 走人）：作废为 rejected，不执行', async () => {
    const p = makeProposal();
    rememberProposal(p);
    const cap = captureBroadcast();
    const ac = new AbortController();
    const { emitted, onProposal } = proposalEmitted();
    let executed = false;

    const running = proposeOrExecute(
      makeToolContext({ conversationId: 'conv_route', agentId: 'agent_1', usage: 'chat', onProposal, abortSignal: ac.signal }),
      p,
      { approvalText: '等审批', execute: async () => ((executed = true), { text: 'ok' }) },
    );
    await emitted;
    ac.abort(); // 工具走人：waiter 以 aborted 兑现并注销，留痕标记留下
    await expect(running).resolves.toEqual({ text: '用户已取消，操作未执行。' });

    await route({ type: 'proposal.execute', reqId: 'r3', proposalId: p.id }, () => {}, cap.broadcast);
    expect(cap.statuses()).toEqual(['rejected']);
    expect(p.status).toBe('rejected');
    expect(executed).toBe(false);
  });
});
