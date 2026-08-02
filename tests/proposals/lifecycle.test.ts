/**
 * proposal 状态机单测——验 lifecycle.ts 收口的承重语义：
 *  - 合法迁移：赋值 + 广播载荷一致；executing 无 completedAt，终态有
 *  - 非法迁移 throw（终态不再动、executing 不可回 rejected）
 *  - failureMessage 只在 failed 落上（executed + failureMessage 并存是矛盾语义）
 */
import { describe, it, expect } from 'vitest';
import { transitionProposal } from '../../electron/main/proposals/lifecycle';
import type { ActionProposal, FileWriteProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';

function makeProposal(): FileWriteProposal {
  return {
    id: 'prop_test_1',
    ownerId: 'local-user',
    conversationId: 'conv_1',
    title: '写文件',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    kind: 'file.write',
    path: '/tmp/x.txt',
    mode: 'create',
    content: 'hi',
  } satisfies FileWriteProposal;
}

function collect(): { events: ServerEvent[]; broadcast: (ev: ServerEvent) => void } {
  const events: ServerEvent[] = [];
  return { events, broadcast: (ev) => events.push(ev) };
}

describe('proposals/lifecycle', () => {
  it('pending → executing：不落 completedAt，广播 executing', () => {
    const p = makeProposal();
    const { events, broadcast } = collect();
    transitionProposal(p, 'executing', broadcast);
    expect(p.status).toBe('executing');
    expect(p.completedAt).toBeUndefined();
    expect(events).toEqual([
      {
        type: 'proposal.statusChanged',
        proposalId: p.id,
        status: 'executing',
        completedAt: undefined,
        failureMessage: undefined,
        serverId: undefined,
      },
    ]);
  });

  it('executing → executed：落 completedAt，广播一致', () => {
    const p = makeProposal();
    const { events, broadcast } = collect();
    transitionProposal(p, 'executing', broadcast);
    transitionProposal(p, 'executed', broadcast);
    expect(p.status).toBe('executed');
    expect(p.completedAt).toBeTypeOf('number');
    expect(events.map((e) => (e as { status: string }).status)).toEqual(['executing', 'executed']);
  });

  it('executing → failed：failureMessage 落上并广播', () => {
    const p = makeProposal();
    const { events, broadcast } = collect();
    transitionProposal(p, 'executing', broadcast);
    transitionProposal(p, 'failed', broadcast, { failureMessage: '磁盘炸了' });
    expect(p.failureMessage).toBe('磁盘炸了');
    expect(events[1]).toMatchObject({ status: 'failed', failureMessage: '磁盘炸了' });
  });

  it('executed 时即使误传 failureMessage 也不落上（矛盾语义挡住）', () => {
    const p = makeProposal();
    const { events, broadcast } = collect();
    transitionProposal(p, 'executed', broadcast, { failureMessage: '不该出现' });
    expect(p.failureMessage).toBeUndefined();
    expect(events[0]).toMatchObject({ status: 'executed', failureMessage: undefined });
  });

  it('终态不再迁移：executed → failed throw', () => {
    const p = makeProposal();
    const { broadcast } = collect();
    transitionProposal(p, 'executed', broadcast);
    expect(() => transitionProposal(p, 'failed', broadcast)).toThrow(/非法 proposal 状态迁移/);
  });

  it('executing → rejected 非法（执行中没有撤回路径）', () => {
    const p = makeProposal();
    const { broadcast } = collect();
    transitionProposal(p, 'executing', broadcast);
    expect(() => transitionProposal(p, 'rejected', broadcast)).toThrow(/非法 proposal 状态迁移/);
  });

  it('pending → rejected / executed / failed 直达均合法（异步 kind 与拒绝路径）', () => {
    for (const next of ['rejected', 'executed', 'failed'] as const) {
      const p: ActionProposal = makeProposal();
      const { broadcast } = collect();
      transitionProposal(p, next, broadcast);
      expect(p.status).toBe(next);
    }
  });
});
