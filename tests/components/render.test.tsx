/**
 * Render smoke：mount 用 zustand store selector 的组件
 *
 * 专门防一类 bug：selector 返回新数组/新对象 → React 触发"Maximum update depth"
 * 历史 bug 实例：
 *  - commit f85af4a：proposalsByConv[id] ?? [] 每次新数组 → 修为 EMPTY_PROPOSALS
 *  - 这次：EscalationBanner 调 escalatedTasks() / TaskCard ?? [] 同模式
 *
 * vitest 单测层挡不住，因为单测里我们直接调 store 函数验状态；
 * 这种 bug 只在 React 实际订阅 + 重渲染时才显现
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useTaskStore } from '@/stores/taskStore';
import { useAgentStore } from '@/stores/agentStore';
import { useProjectStore } from '@/stores/projectStore';
import { EscalationBanner } from '@/components/EscalationBanner';
import { TaskCard } from '@/components/TaskCard';
import { ProposalCard } from '@/components/ProposalCard';
import type { ActionProposal, Agent, Project, SubagentTask } from '@shared/types';

function makeProposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    kind: 'code',
    id: 'p1',
    ownerId: 'local-user',
    conversationId: 'cnv',
    status: 'pending',
    title: 'test',
    description: 'd',
    targetProjectId: 'prj_1',
    risk: 'low',
    rollbackable: true,
    rawPlan: 'plan',
    createdAt: 1000,
    profileId: 'project-coder',
    ...overrides,
  } as ActionProposal;
}

function makeTask(overrides: Partial<SubagentTask> = {}): SubagentTask {
  return {
    id: 't1',
    agentId: 'twin',
    conversationId: 'cnv',
    proposalId: 'p1',
    proposalTitle: '测试任务',
    targetProjectId: 'prj_1',
    status: 'running',
    baselineCommit: 'abc',
    summary: null,
    errorMessage: null,
    startedAt: 1000,
    finishedAt: null,
    profileId: 'project-coder',
    endTag: null,
    affectedPaths: [],
    commitsCreated: [],
    announcedAt: null,
    featureBranch: null,
    ...overrides,
  };
}

beforeEach(() => {
  useTaskStore.setState({
    tasks: {},
    proposalsByConv: {},
    progressByTask: {},
    questionsByTask: {},
    expandedCards: new Set<string>(),
    justFinishedTaskId: null,
  });
});

afterEach(() => {
  cleanup();
});

/**
 * 关键检查：组件 mount 不抛任何 React 错误（含 console.error / console.warn）
 * 任何 "Maximum update depth" / "result of getSnapshot should be cached" 都会被 vi 捕获
 */
function expectNoReactErrors(renderFn: () => void): void {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    renderFn();
  } finally {
    const errors = errorSpy.mock.calls.flat().filter((arg) => typeof arg === 'string');
    const warnings = warnSpy.mock.calls.flat().filter((arg) => typeof arg === 'string');
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    const bad = [
      ...errors.filter((s) => /Maximum update depth/i.test(s)),
      ...warnings.filter((s) => /getSnapshot should be cached/i.test(s)),
    ];
    if (bad.length > 0) {
      throw new Error(`React 检测到无限循环类警告/错误：\n${bad.join('\n---\n')}`);
    }
  }
}

describe('EscalationBanner', () => {
  it('mount 无 escalated task 时不崩 / 不无限循环', () => {
    expectNoReactErrors(() => {
      render(<EscalationBanner />);
    });
  });

  it('mount 1 个 escalated task 时不崩', () => {
    useTaskStore.setState({
      tasks: { t1: makeTask({ id: 't1', status: 'awaiting_user' }) },
    });
    expectNoReactErrors(() => {
      render(<EscalationBanner />);
    });
  });

  it('mount 多个 escalated task 时不崩', () => {
    useTaskStore.setState({
      tasks: {
        t1: makeTask({ id: 't1', status: 'awaiting_user' }),
        t2: makeTask({ id: 't2', status: 'awaiting_user' }),
        t3: makeTask({ id: 't3', status: 'running' }),
      },
    });
    expectNoReactErrors(() => {
      render(<EscalationBanner />);
    });
  });

  it('state 更新（add awaiting_user task）后不抛无限循环', () => {
    expectNoReactErrors(() => {
      const { rerender } = render(<EscalationBanner />);
      useTaskStore.setState({
        tasks: { t1: makeTask({ id: 't1', status: 'awaiting_user' }) },
      });
      rerender(<EscalationBanner />);
    });
  });
});

describe('TaskCard', () => {
  it('mount 仅 proposal（无 task）→ ProposalView 不崩', () => {
    expectNoReactErrors(() => {
      render(<TaskCard proposal={makeProposal({ id: 'p1' })} />);
    });
  });

  it('mount running task（无 questions）→ RunningView 不崩', () => {
    useTaskStore.setState({
      tasks: { t1: makeTask({ id: 't1', proposalId: 'p1', status: 'running' }) },
      expandedCards: new Set(['t1']), // 强制走展开态触发 questions 路径
    });
    expectNoReactErrors(() => {
      render(<TaskCard proposal={makeProposal({ id: 'p1' })} />);
    });
  });

  it('mount running task 折叠态也不崩', () => {
    useTaskStore.setState({
      tasks: { t1: makeTask({ id: 't1', proposalId: 'p1', status: 'running' }) },
      expandedCards: new Set<string>(),
    });
    expectNoReactErrors(() => {
      render(<TaskCard proposal={makeProposal({ id: 'p1' })} />);
    });
  });

  it('mount awaiting_user task（含 questions）展开态不崩', () => {
    useTaskStore.setState({
      tasks: { t1: makeTask({ id: 't1', proposalId: 'p1', status: 'awaiting_user' }) },
      expandedCards: new Set(['t1']),
      questionsByTask: {
        t1: [
          {
            id: 'q1',
            taskId: 't1',
            question: '要换吗?',
            contextPaths: [],
            askedAt: 100,
            answer: null,
            twinProcessedAnswer: null,
            answeredBy: null,
            answeredAt: null,
          },
        ],
      },
    });
    expectNoReactErrors(() => {
      render(<TaskCard proposal={makeProposal({ id: 'p1' })} />);
    });
  });

  it('多次 setState 不触发循环', () => {
    expectNoReactErrors(() => {
      const { rerender } = render(<TaskCard proposal={makeProposal({ id: 'p1' })} />);
      useTaskStore.setState({
        tasks: { t1: makeTask({ id: 't1', proposalId: 'p1', status: 'running' }) },
      });
      rerender(<TaskCard proposal={makeProposal({ id: 'p1' })} />);
      useTaskStore.setState({
        tasks: { t1: makeTask({ id: 't1', proposalId: 'p1', status: 'awaiting_user' }) },
      });
      rerender(<TaskCard proposal={makeProposal({ id: 'p1' })} />);
    });
  });
});

// ─── ProposalCard：非 git 项目不再拦截，仅底部如实标注「不可自动回滚」──────────────────

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'prj_1',
    name: 'demo',
    path: '/tmp/demo',
    addedAt: 0,
    lastOpenedAt: 0,
    hasClaudeMd: false,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent_twin',
    name: 'Twin',
    homePath: '/tmp/agent_home',
    systemPromptAppend: null,
    // 只读挡：router 不自动派工，CodeProposalCard 渲染手动「让他去做」按钮——gitGuard 用例测的就是它
    approvalMode: 'readonly',
    createdAt: 0,
    ...overrides,
  };
}

describe('ProposalCard', () => {
  beforeEach(() => {
    useAgentStore.setState({
      agents: [makeAgent()],
      activeAgentId: 'agent_twin',
    });
    useProjectStore.setState({
      projects: [makeProject({ id: 'prj_1' })],
      activeProjectId: 'prj_1',
      loading: false,
      error: null,
    });
    useTaskStore.setState({
      tasks: {},
      proposalsByConv: {},
      progressByTask: {},
      questionsByTask: {},
      expandedCards: new Set<string>(),
      justFinishedTaskId: null,
    });
  });

  it('rollbackable=true（git 项目）→ 按钮启用，meta 行显示"可一键回滚"', () => {
    expectNoReactErrors(() => {
      render(
        <ProposalCard proposal={makeProposal({ rollbackable: true, targetProjectId: 'prj_1' })} />,
      );
    });
    expect(screen.getByText('让他去做').closest('button')?.disabled).toBe(false);
    expect(screen.getByText('可一键回滚')).toBeTruthy();
  });

  it('rollbackable=false（非 git 项目）→ 按钮仍启用，meta 行如实标注"不可自动回滚"红字', () => {
    expectNoReactErrors(() => {
      render(
        <ProposalCard proposal={makeProposal({ rollbackable: false, targetProjectId: 'prj_1' })} />,
      );
    });
    // 不再拦截：按钮照常可点
    expect(screen.getByText('让他去做').closest('button')?.disabled).toBe(false);
    expect(screen.getByText('算了').closest('button')?.disabled).toBe(false);
    expect(screen.getByText(/不可自动回滚（项目未启用 git）/)).toBeTruthy();
  });

  it('拦截链路已删：非 git 项目不再出现 banner / 跳过按钮', () => {
    expectNoReactErrors(() => {
      render(
        <ProposalCard proposal={makeProposal({ rollbackable: false, targetProjectId: 'prj_1' })} />,
      );
    });
    expect(screen.queryByTestId('git-guard-banner')).toBeNull();
    expect(screen.queryByText('跳过本次')).toBeNull();
    expect(screen.queryByText('今日不再提醒')).toBeNull();
  });
});
