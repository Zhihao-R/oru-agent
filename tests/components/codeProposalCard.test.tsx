/**
 * CodeProposalCard：status 离开 pending 后的呈现——已决静态，不得永转「派工中…」。
 *
 * 病灶（2026-07-03 审查修正）：dispatched = submitting || status !== 'pending' 时按钮
 * 一律渲染 Loader+「派工中…」——failed（任务没起来）的卡片永久旋转，是状态谎言。
 * 正确：仅点击后的短暂过渡显示派工中；executing / 终态显示静态状态行（PM 定稿：
 * 已决即静态，不复述执行结果）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/ws', () => ({ wsClient: { request } }));

import { CodeProposalCard } from '@/components/CodeProposalCard';
import { useAgentStore } from '@/stores/agentStore';
import type { ActionProposal, Agent } from '@shared/types';

type CodeProposal = Extract<ActionProposal, { kind: 'code' }>;

function makeCode(overrides: Partial<CodeProposal> = {}): CodeProposal {
  return {
    kind: 'code',
    id: 'p1',
    ownerId: 'u',
    conversationId: 'c',
    title: '改代码',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    targetProjectId: 'proj',
    risk: 'low',
    rollbackable: true,
    rawPlan: '计划',
    ...overrides,
  };
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({});
  // readonly 挡才渲染手动派工按钮（work/danger 是自动派工提示行）
  useAgentStore.setState({
    activeAgentId: 'twin',
    agents: [{ id: 'twin', approvalMode: 'readonly' } as Agent],
  });
});
afterEach(() => cleanup());

describe('CodeProposalCard 已决静态呈现', () => {
  it('pending → 三按钮可点，无「派工中…」', () => {
    render(<CodeProposalCard proposal={makeCode()} />);
    expect(screen.getByText('让他去做')).toBeTruthy();
    expect(screen.queryByText('派工中…')).toBeNull();
  });

  it('点「让他去做」→ 短暂过渡显示「派工中…」', () => {
    render(<CodeProposalCard proposal={makeCode()} />);
    fireEvent.click(screen.getByText('让他去做'));
    expect(screen.getByText('派工中…')).toBeTruthy();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'proposal.execute', proposalId: 'p1' }),
    );
  });

  it('failed（任务没起来）→ 收敛为一行「已批准」终态，不出现「派工中…」、按钮收走（G31）', () => {
    render(
      <CodeProposalCard proposal={makeCode({ status: 'failed', failureMessage: 'spawn 失败' })} />,
    );
    expect(screen.queryByText('派工中…')).toBeNull();
    expect(screen.queryByText('让他去做')).toBeNull();
    // G31：卡片只当决定存证，成败由对话流展示——failed 归入「已批准」（执行过），不再直显失败细节
    expect(screen.getByText('已批准')).toBeTruthy();
  });

  it('rejected → 收敛为一行「已拒绝」终态，不出现「派工中…」（G31）', () => {
    render(<CodeProposalCard proposal={makeCode({ status: 'rejected' })} />);
    expect(screen.queryByText('派工中…')).toBeNull();
    expect(screen.getByText('已拒绝')).toBeTruthy();
  });

  it('executing → 收敛为一行「已批准」终态（无动效），不出现「派工中…」（G31）', () => {
    const { container } = render(<CodeProposalCard proposal={makeCode({ status: 'executing' })} />);
    expect(screen.queryByText('派工中…')).toBeNull();
    expect(screen.getByText('已批准')).toBeTruthy();
    expect(container.querySelector('.animate-spin')).toBeNull(); // G31：已决即静态
  });
});
