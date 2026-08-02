/**
 * 折叠相邻 bash 提案（决策 2）——目标 bug 回归：多张重复授权卡折成一组翻页卡。
 */
import { describe, expect, it } from 'vitest';
import { foldBashProposalGroups, type TimelineItem } from '@/lib/foldBashProposalGroups';
import type { ActionProposal } from '@shared/types';

function bash(id: string, status: ActionProposal['status'] = 'pending'): ActionProposal {
  return {
    kind: 'bash',
    id,
    ownerId: 'u',
    conversationId: 'c',
    title: '执行命令',
    description: id,
    createdAt: 1,
    status,
    command: `echo ${id}`,
    isDestructive: false,
    segments: [],
  } as ActionProposal;
}

function mcp(id: string): ActionProposal {
  return {
    kind: 'mcp.install',
    id,
    ownerId: 'u',
    conversationId: 'c',
    title: 'install',
    description: id,
    createdAt: 1,
    status: 'pending',
    config: {} as never,
  } as ActionProposal;
}

const msg = (key: string): TimelineItem<{ id: string }> => ({
  kind: 'message',
  key,
  ts: 1,
  data: { id: key },
});
const prop = (p: ActionProposal): TimelineItem<{ id: string }> => ({
  kind: 'proposal',
  key: `proposal_${p.id}`,
  ts: 1,
  data: p,
});

describe('foldBashProposalGroups', () => {
  it('相邻多条 bash 折成一组（目标 bug：不再多张并排）', () => {
    const out = foldBashProposalGroups([prop(bash('a')), prop(bash('b'))]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('proposalGroup');
    if (out[0].kind === 'proposalGroup') expect(out[0].data.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('组成员含已 executed / rejected 的，不按 status 过滤（成员集稳定）', () => {
    const out = foldBashProposalGroups([
      prop(bash('a', 'executed')),
      prop(bash('b', 'rejected')),
      prop(bash('c', 'pending')),
    ]);
    expect(out).toHaveLength(1);
    if (out[0].kind === 'proposalGroup') expect(out[0].data).toHaveLength(3);
  });

  it('中间插一条消息 → 断成两组', () => {
    const out = foldBashProposalGroups([prop(bash('a')), msg('m1'), prop(bash('b'))]);
    expect(out.map((i) => i.kind)).toEqual(['proposalGroup', 'message', 'proposalGroup']);
  });

  it('中间插非 bash 提案 → 断开，非 bash 保持独立 proposal', () => {
    const out = foldBashProposalGroups([prop(bash('a')), prop(mcp('x')), prop(bash('b'))]);
    expect(out.map((i) => i.kind)).toEqual(['proposalGroup', 'proposal', 'proposalGroup']);
  });

  it('孤立单条 bash → 组里只 1 条（渲染层据此退化单卡）', () => {
    const out = foldBashProposalGroups([msg('m'), prop(bash('a'))]);
    expect(out[1].kind).toBe('proposalGroup');
    if (out[1].kind === 'proposalGroup') expect(out[1].data).toHaveLength(1);
  });

  it('非 bash 提案不进组', () => {
    const out = foldBashProposalGroups([prop(mcp('x'))]);
    expect(out[0].kind).toBe('proposal');
  });
});
