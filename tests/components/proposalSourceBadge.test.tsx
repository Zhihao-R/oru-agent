/** @vitest-environment jsdom */
/**
 * 回流审批卡溯源标注（G79）——subagent / 定时任务 / Loop 触发的审批卡在卡顶挂一行溯源，
 * 让用户知道「这张卡不是我这轮亲手让 Oru 做的」。ProposalCard dispatcher 层统一挂
 * ProposalSourceBadge，各 kind 子卡零改动。本测试锁「来自 subagent」这一支不被回归漏渲染。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { BashProposal } from '@shared/types';
import { ProposalCard } from '@/components/ProposalCard';

function makeBashProposal(overrides: Partial<BashProposal> = {}): BashProposal {
  return {
    id: 'p1',
    conversationId: 'cnv',
    title: '运行命令',
    createdAt: 1000,
    status: 'pending',
    kind: 'bash',
    command: 'npm test',
    isDestructive: false,
    isReadOnly: false,
    segments: [{ text: 'npm test', destructive: false }],
    ...overrides,
  };
}

afterEach(cleanup);

describe('ProposalSourceBadge · 回流卡溯源（G79）', () => {
  it('triggeredBySubagent → 渲染「来自 subagent：<描述>」', () => {
    const proposal = makeBashProposal({
      triggeredBySubagent: { taskId: 't1', description: '整理测试目录' },
    });
    render(<ProposalCard proposal={proposal} />);
    expect(screen.getByText(/来自 subagent：整理测试目录/)).toBeTruthy();
  });

  it('无触发来源 → 不挂溯源行', () => {
    render(<ProposalCard proposal={makeBashProposal()} />);
    expect(screen.queryByText(/来自 subagent/)).toBeNull();
  });
});
