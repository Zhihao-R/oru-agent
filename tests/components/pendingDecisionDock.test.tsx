/**
 * PendingDecisionDock（话-1 结构迁移回归）：
 * - pending 审批卡沉入面板可操作；非 pending（已派工/终态）不进面板
 * - 审批与追问互斥：有 pending 审批时追问不占面板（审批优先）
 * - 无 pending 审批、有待答追问 → 追问进面板
 * - 多条 pending 逐条翻页（无批量，安全不变量）
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/ws', () => ({ wsClient: { request } }));

import { PendingDecisionDock } from '@/components/chat/PendingDecisionDock';
import { useAgentStore } from '@/stores/agentStore';
import { useTaskStore } from '@/stores/taskStore';
import { useChatStore, type AskUserChoicePending } from '@/stores/chatStore';
import type { ActionProposal, Agent, BashProposal } from '@shared/types';

const CONV = 'c1';

function makeBash(overrides: Partial<BashProposal> = {}): BashProposal {
  return {
    kind: 'bash',
    id: 'p1',
    ownerId: 'u',
    conversationId: CONV,
    title: '整理访谈纪要',
    description: 'ls',
    createdAt: 1,
    status: 'pending',
    command: 'ls -la',
    isDestructive: false,
    segments: [],
    ...overrides,
  };
}

function makeAsk(overrides: Partial<AskUserChoicePending> = {}): AskUserChoicePending {
  return {
    askId: 'a1',
    conversationId: CONV,
    messageId: 'm1',
    questions: [
      {
        header: '排序',
        question: '纪要采用何种排序方式？',
        options: [{ label: '按频次' }, { label: '按场次' }],
      },
    ],
    ...overrides,
  } as AskUserChoicePending;
}

/** 排队中的 code 派工（异步 subagent）：恒自动执行、从不走审批 */
function makeCode(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    kind: 'code',
    id: 'pc1',
    ownerId: 'u',
    conversationId: CONV,
    title: '改代码',
    description: '派个 subagent 改代码',
    createdAt: 1,
    status: 'pending',
    targetProjectId: 'prj_1',
    risk: 'low',
    rawPlan: 'do',
    ...overrides,
  } satisfies ActionProposal;
}

function seed(proposals: ActionProposal[], asks: AskUserChoicePending[]) {
  useTaskStore.setState({ proposalsByConv: { [CONV]: proposals }, tasks: {} });
  const pendingAsks: Record<string, AskUserChoicePending> = {};
  for (const a of asks) pendingAsks[a.askId] = a;
  useChatStore.setState({ pendingAsks });
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({});
  useAgentStore.setState({
    activeAgentId: 'twin',
    agents: [{ id: 'twin', approvalMode: 'work' } as Agent],
  });
});
afterEach(() => cleanup());

describe('PendingDecisionDock', () => {
  it('pending 审批卡沉入面板、可操作（出「拒绝」）', () => {
    seed([makeBash()], []);
    render(<PendingDecisionDock conversationId={CONV} />);
    expect(screen.getByText('拒绝')).toBeTruthy();
  });

  it('非 pending（已派工/终态）不进面板 → 面板空', () => {
    seed([makeBash({ status: 'executing' })], []);
    const { container } = render(<PendingDecisionDock conversationId={CONV} />);
    expect(container.textContent).toBe('');
  });

  it('审批与追问互斥：有 pending 审批时追问不占面板', () => {
    seed([makeBash()], [makeAsk()]);
    render(<PendingDecisionDock conversationId={CONV} />);
    expect(screen.getByText('拒绝')).toBeTruthy(); // 审批在
    expect(screen.queryByText('纪要采用何种排序方式？')).toBeNull(); // 追问让位
  });

  it('无 pending 审批、有待答追问 → 追问进面板', () => {
    seed([], [makeAsk()]);
    render(<PendingDecisionDock conversationId={CONV} />);
    expect(screen.getByText('纪要采用何种排序方式？')).toBeTruthy();
  });

  it('多条 pending 逐条翻页：只显一条 + 翻页器 1 / 2（无批量）', () => {
    seed([makeBash({ id: 'p1', title: '任务甲' }), makeBash({ id: 'p2', title: '任务乙' })], []);
    render(<PendingDecisionDock conversationId={CONV} />);
    expect(screen.getByText('1 / 2')).toBeTruthy();
    // 逐条：同一时刻只一张卡（一个「拒绝」按钮）
    expect(screen.getAllByText('拒绝')).toHaveLength(1);
  });

  it('混合状态：面板只收 pending，已派工/终态不进（配合 ChatArea 拆分避免双重可批）', () => {
    seed(
      [makeBash({ id: 'p1', status: 'executing' }), makeBash({ id: 'p2', status: 'pending' })],
      [],
    );
    render(<PendingDecisionDock conversationId={CONV} />);
    // 只一条 pending（p2），无翻页器
    expect(screen.getByText('拒绝')).toBeTruthy();
    expect(screen.queryByText('1 / 2')).toBeNull();
  });

  it('code 派工排队（pending）不进审批面板：不弹「拒绝」，不影响追问接管', () => {
    seed([makeCode()], []);
    const { container } = render(<PendingDecisionDock conversationId={CONV} />);
    expect(container.textContent).toBe('');
    // code pending 不阻断：有待答追问时追问照常进面板
    cleanup();
    seed([makeCode()], [makeAsk()]);
    render(<PendingDecisionDock conversationId={CONV} />);
    expect(screen.getByText('纪要采用何种排序方式？')).toBeTruthy();
  });
});
