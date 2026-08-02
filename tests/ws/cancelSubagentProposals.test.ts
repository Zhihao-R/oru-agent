/**
 * 取消后台任务撤悬挂审批卡（只读重构 C 块「前端撤卡」）。
 * 验证 cancelSubagentProposals 只把"该任务触发的 pending 卡"转 rejected + 广播，
 * 不碰其它任务的卡、不碰非 subagent 卡、不碰已终态卡。
 */
import { describe, it, expect } from 'vitest';
import { rememberProposal, cancelSubagentProposals, getProposal } from '../../electron/main/proposals/registry';
import type { ActionProposal, BashProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';

let seq = 0;
function bashProposal(opts: {
  taskId?: string;
  status?: ActionProposal['status'];
}): BashProposal {
  return {
    id: `prop_cancel_${seq++}`,
    ownerId: 'local-user',
    conversationId: 'main_twin',
    title: '执行命令',
    description: 'x',
    createdAt: 1,
    status: opts.status ?? 'pending',
    kind: 'bash',
    command: 'rm x',
    isDestructive: true,
    isReadOnly: false,
    segments: [{ text: 'rm x', destructive: true }],
    forceApproval: true,
    triggeredBySubagent: opts.taskId ? { taskId: opts.taskId, description: '任务 A' } : undefined,
  } satisfies BashProposal;
}

describe('cancelSubagentProposals 撤悬挂卡', () => {
  it('只撤本任务的 pending 卡，不波及其它任务 / 非 subagent / 已终态卡', () => {
    const mine = bashProposal({ taskId: 'task_X' }); // 本任务 pending → 应撤
    const otherTask = bashProposal({ taskId: 'task_Y' }); // 别的任务 → 不动
    const notSubagent = bashProposal({}); // 主对话自己的卡（无 triggeredBySubagent）→ 不动
    const alreadyDone = bashProposal({ taskId: 'task_X', status: 'executed' }); // 本任务但已终态 → 不动
    for (const p of [mine, otherTask, notSubagent, alreadyDone]) rememberProposal(p);

    const events: ServerEvent[] = [];
    cancelSubagentProposals('task_X', (ev) => events.push(ev));

    expect(getProposal(mine.id)?.status).toBe('rejected');
    expect(getProposal(otherTask.id)?.status).toBe('pending');
    expect(getProposal(notSubagent.id)?.status).toBe('pending');
    expect(getProposal(alreadyDone.id)?.status).toBe('executed');

    // 恰好广播一条 proposal.statusChanged（撤的那张），未读据此递减
    const statusEvents = events.filter((e) => e.type === 'proposal.statusChanged');
    expect(statusEvents).toHaveLength(1);
    expect((statusEvents[0] as { proposalId: string; status: string }).proposalId).toBe(mine.id);
    expect((statusEvents[0] as { status: string }).status).toBe('rejected');
  });

  it('该任务没有 pending 卡时是 no-op（不广播）', () => {
    const events: ServerEvent[] = [];
    cancelSubagentProposals('task_nonexistent', (ev) => events.push(ev));
    expect(events).toHaveLength(0);
  });
});
