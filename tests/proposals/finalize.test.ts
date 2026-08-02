/**
 * 「假已执行」回归——验同步审批路径的真实终态回报链：
 * router 批准只转 executing，executed/failed 由工具执行结果经 finalizeProposalExecution 回报。
 *
 * 目标 bug（假已执行）：旧 router 在 settle 'approved' 的瞬间就广播 executed——工具还没跑、
 * 甚至会失败，卡片却已说"已执行"。本文件按修复后的协作方式整链模拟
 * （finalizer 注册 + settle + proposeOrExecute），核心断言：
 *  - execute() 未完成前绝不出现终态广播（只有 executing）
 *  - execute 抛错 / 返回 isError → failed（带错因），成功 → executed
 *  - 拒绝路径不执行、不回报终态
 */
import { describe, it, expect } from 'vitest';
import { proposeOrExecute } from '../../electron/main/agent/agentTools/emitProposal';
import {
  registerProposalFinalizer,
  settleProposalDecision,
  unregisterProposalFinalizer,
  finalizeProposalExecution,
  type ProposalExecOutcome,
} from '../../electron/main/proposals/pendingDecision';
import { transitionProposal } from '../../electron/main/proposals/lifecycle';
import type { ToolContext, ToolResult } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';
import type { BashProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';

let seq = 0;
function makeProposal(): BashProposal {
  return {
    id: `prop_finalize_${seq++}`,
    ownerId: 'local-user',
    conversationId: 'conv_1',
    title: '跑命令',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    kind: 'bash',
    command: 'echo hi',
    isDestructive: false,
    isReadOnly: false,
    segments: [{ text: 'echo hi', destructive: false }],
    // 走审批流（只读重构后挡位不再"什么都问"）：forceApproval 让 work 挡也停下等确认——
    // 本文件测的是 finalize 终态链，与挡位无关，只需确保进入审批路径。
    forceApproval: true,
  } satisfies BashProposal;
}

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return makeToolContext({
    conversationId: 'conv_1',
    // agent_1 在磁盘不存在 → realtimeApprovalMode 的 getAgent 抛错回落到此 ctx.approvalMode
    agentId: 'agent_1',
    ownerId: 'local-user',
    usage: 'chat',
    ...overrides,
  });
}

/** 模拟 router 批准：注册 finalizer（转发到状态机）→ settle → 转 executing。 */
function approveLikeRouter(p: BashProposal, events: ServerEvent[]): void {
  const broadcast = (ev: ServerEvent) => events.push(ev);
  registerProposalFinalizer(p.id, (outcome: ProposalExecOutcome) => {
    transitionProposal(
      p,
      outcome.status,
      broadcast,
      outcome.status === 'failed' ? { failureMessage: outcome.failureMessage } : undefined,
    );
  });
  expect(settleProposalDecision(p.id, 'approved')).toBe(true);
  transitionProposal(p, 'executing', broadcast);
}

const statuses = (events: ServerEvent[]) =>
  events
    .filter((e) => e.type === 'proposal.statusChanged')
    .map((e) => (e as { status: string }).status);

describe('假已执行回归（finalize 链）', () => {
  it('批准后 execute 完成前只有 executing，完成后才 executed', async () => {
    const p = makeProposal();
    const events: ServerEvent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const running = proposeOrExecute(makeCtx(), p, {
      approvalText: '等审批',
      execute: async () => {
        await gate;
        return { text: 'ok' };
      },
    });
    await new Promise((r) => setTimeout(r, 20)); // 让 proposeOrExecute 跑完 realtimeApprovalMode(async getAgent) + waiter 注册 + onProposal
    approveLikeRouter(p, events);

    // 工具还卡在 execute 里——绝不能已有终态（这正是假已执行的病灶）
    await new Promise((r) => setTimeout(r, 0));
    expect(statuses(events)).toEqual(['executing']);
    expect(p.status).toBe('executing');

    release();
    await expect(running).resolves.toEqual({ text: 'ok' });
    expect(statuses(events)).toEqual(['executing', 'executed']);
    expect(p.status).toBe('executed');
  });

  it('execute 抛错 → failed（带错因），错误照常上抛', async () => {
    const p = makeProposal();
    const events: ServerEvent[] = [];
    const running = proposeOrExecute(makeCtx(), p, {
      approvalText: '等审批',
      execute: async () => {
        throw new Error('命令崩了');
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    approveLikeRouter(p, events);

    await expect(running).rejects.toThrow('命令崩了');
    expect(statuses(events)).toEqual(['executing', 'failed']);
    expect(p.failureMessage).toBe('命令崩了');
  });

  it('execute 返回 isError → failed，结果原样返回给模型', async () => {
    const p = makeProposal();
    const events: ServerEvent[] = [];
    const errResult: ToolResult = { isError: true, text: 'bash: 超时' };
    const running = proposeOrExecute(makeCtx(), p, {
      approvalText: '等审批',
      execute: async () => errResult,
    });
    await new Promise((r) => setTimeout(r, 20));
    approveLikeRouter(p, events);

    await expect(running).resolves.toEqual(errResult);
    expect(statuses(events)).toEqual(['executing', 'failed']);
    expect(p.failureMessage).toBe('bash: 超时');
  });

  it('拒绝路径：execute 不跑，不出终态回报', async () => {
    const p = makeProposal();
    let executed = false;
    const running = proposeOrExecute(makeCtx(), p, {
      approvalText: '等审批',
      execute: async () => {
        executed = true;
        return { text: 'ok' };
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settleProposalDecision(p.id, 'rejected')).toBe(true);
    await expect(running).resolves.toEqual({ text: '用户拒绝了这次操作，未执行。' });
    expect(executed).toBe(false);
  });

  it('finalizer 一次性消费 + 无注册时 no-op（信任模式不挂也安全）', () => {
    let calls = 0;
    registerProposalFinalizer('prop_once', () => calls++);
    finalizeProposalExecution('prop_once', { status: 'executed' });
    finalizeProposalExecution('prop_once', { status: 'executed' });
    expect(calls).toBe(1);
    finalizeProposalExecution('prop_never_registered', { status: 'executed' });
  });

  it('unregister 后 finalize 落空（僵尸卡撤销注册路径）', () => {
    let calls = 0;
    registerProposalFinalizer('prop_zombie', () => calls++);
    unregisterProposalFinalizer('prop_zombie');
    finalizeProposalExecution('prop_zombie', { status: 'executed' });
    expect(calls).toBe(0);
  });
});
