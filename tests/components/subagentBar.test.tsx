/** @vitest-environment jsdom */
/**
 * Subagent 底部聚合指示条（2026-07-29 拍板，PRD docs/prd/2026-07-29-subagent运行指示与完成卡-prd.md；
 * 委派收敛 §6.1 收 async 进同一条）：
 * - 活物沉底：运行中（含等确认）由条承载，不占消息流；收起态只答「几个进行中 / 有没有等你确认」
 * - 同步（ChatMessage kind=subagent）与异步（TaskStore 里本对话的 inflight SubagentTask）两源同构归一行
 * - 点条展开逐行：呼吸灯 + 标题 + 当前动作（右对齐）；等确认行 warn 色 + 「等你确认」
 * - 终态原位闪「✓ 完成 / ✕ 失败」约 1.5s 退场；无剩余进行中则整条退场
 * - 条内无审批按钮、无停止按钮（审批归停靠面板；停 subagent 走对话）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { ActionProposal, Agent, ChatMessage, SubagentChipRef, SubagentTask } from '@shared/types';

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(_p: ClientRequestPayload): Promise<T> => {
      return { type: 'ok' } as unknown as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { SubagentBar } from '@/components/chat/SubagentBar';
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';

const CONV = 'cnv_sub1';

function task(id: string, overrides: Partial<SubagentTask> = {}): SubagentTask {
  return {
    id,
    agentId: 'twin',
    conversationId: CONV,
    proposalId: `p_${id}`,
    proposalTitle: `任务${id}`,
    targetProjectId: 'prj_1',
    status: 'running',
    baselineCommit: null,
    summary: null,
    errorMessage: null,
    startedAt: 1,
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

function chipMsg(id: string, ref: Partial<SubagentChipRef> & { status: SubagentChipRef['status'] }): ChatMessage {
  return {
    id,
    conversationId: CONV,
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: 1,
    done: true,
    kind: 'subagent',
    subagent: {
      taskId: `sub_${id}`,
      description: `任务${id}`,
      prompt: '去做事',
      startedAt: 1,
      ...ref,
    },
  };
}

function setMessages(list: ChatMessage[]) {
  useChatStore.setState((s) => ({ conversations: { ...s.conversations, [CONV]: list } }));
}

/** 排队中的 code 派工：只有 proposal、无 task（proposalId 与 task 的 proposalId 对齐） */
function queuedCodeProposal(id: string, overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    id,
    ownerId: 'local-user',
    conversationId: CONV,
    kind: 'code',
    title: `任务${id}`,
    description: `派工${id}`,
    createdAt: 1,
    status: 'pending',
    targetProjectId: 'prj_1',
    risk: 'low',
    rawPlan: 'do',
    ...overrides,
  } satisfies ActionProposal;
}

beforeEach(() => {
  useChatStore.setState({ conversations: {} });
  useTaskStore.setState({ tasks: {}, progressByTask: {}, proposalsByConv: {} });
  // 默认 work 挡（code 派工 auto 执行、归 SubagentBar 排队行）；readonly 场景用例单独覆盖
  useAgentStore.setState({
    activeAgentId: 'twin',
    agents: [{ id: 'twin', ownerId: 'local-user', name: 'twin', homePath: '/tmp', systemPromptAppend: null, approvalMode: 'work', createdAt: 1, avatarPath: null } satisfies Agent],
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Subagent 聚合指示条', () => {
  it('无 subagent 消息 → 不渲染；仅终态 chip → 不渲染', () => {
    setMessages([]);
    const { container, rerender } = render(<SubagentBar conversationId={CONV} />);
    expect(container.firstChild).toBeNull();

    act(() => {
      setMessages([chipMsg('c1', { status: 'completed', completedAt: 9, finalText: '做完了' })]);
    });
    rerender(<SubagentBar conversationId={CONV} />);
    expect(container.firstChild).toBeNull();
  });

  it('收起头：N 个进行中 + awaiting 计数；无进度灰字、无停止按钮', () => {
    setMessages([
      chipMsg('c1', { status: 'running', activity: { source: 'speech', text: '正在对比两版译法…' }, startedAt: 1 }),
      chipMsg('c2', { status: 'running', startedAt: 2 }),
      chipMsg('c3', { status: 'awaiting_approval', startedAt: 3 }),
    ]);
    render(<SubagentBar conversationId={CONV} />);
    expect(screen.getByText('3 个进行中')).toBeTruthy();
    expect(screen.getByText('· 1 个等你确认')).toBeTruthy();
    expect(screen.queryByText('正在对比两版译法…')).toBeNull(); // 进度属于展开态
    expect(screen.queryByText('停止')).toBeNull();
  });

  it('点条展开：逐行标题 + 当前动作；等审批行有「等你确认」；点条外收起', () => {
    setMessages([
      chipMsg('c1', { status: 'running', activity: { source: 'speech', text: '正在对比两版译法…' }, startedAt: 1 }),
      chipMsg('c3', { status: 'awaiting_approval', startedAt: 3 }),
    ]);
    render(<SubagentBar conversationId={CONV} />);

    fireEvent.click(screen.getByText('2 个进行中'));
    expect(screen.getByText('任务c1')).toBeTruthy();
    expect(screen.getByText('正在对比两版译法…')).toBeTruthy();
    expect(screen.getByText('等你确认')).toBeTruthy();
    // 条内不放审批/停止入口
    expect(screen.queryByText('批准')).toBeNull();
    expect(screen.queryByText('停止')).toBeNull();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByText('正在对比两版译法…')).toBeNull();
  });

  it('一个完成：原位闪「✓ 完成」，1.5s 后恢复计数', () => {
    vi.useFakeTimers();
    setMessages([
      chipMsg('c1', { status: 'running', startedAt: 1 }),
      chipMsg('c2', { status: 'running', startedAt: 2 }),
    ]);
    render(<SubagentBar conversationId={CONV} />);
    expect(screen.getByText('2 个进行中')).toBeTruthy();

    act(() => {
      setMessages([
        chipMsg('c1', { status: 'completed', completedAt: 9, finalText: '做完了', startedAt: 1 }),
        chipMsg('c2', { status: 'running', startedAt: 2 }),
      ]);
    });
    expect(screen.getByText(/任务c1/)).toBeTruthy();
    expect(screen.getByText(/完成/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByText('1 个进行中')).toBeTruthy();
  });

  it('全部到达终态：闪退后整条退场；失败为「✕ 失败」', () => {
    vi.useFakeTimers();
    setMessages([chipMsg('c1', { status: 'running', startedAt: 1 })]);
    const { container } = render(<SubagentBar conversationId={CONV} />);

    act(() => {
      setMessages([chipMsg('c1', { status: 'error', errorMessage: '炸了', completedAt: 9, startedAt: 1 })]);
    });
    expect(screen.getByText(/任务c1/)).toBeTruthy();
    expect(screen.getByText(/失败/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(container.firstChild).toBeNull();
  });

  it('首次挂载就带着运行中 chip 进场：不误闪（无历史可消失）', () => {
    vi.useFakeTimers();
    setMessages([chipMsg('c1', { status: 'running', startedAt: 1 })]);
    render(<SubagentBar conversationId={CONV} />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByText('1 个进行中')).toBeTruthy();
    expect(screen.queryByText(/完成/)).toBeNull();
  });

  it('async 子 agent inflight 沉入同一条：计数合流、展开逐行、awaiting 那盏灯', () => {
    act(() => {
      useTaskStore.setState({
        tasks: {
          a1: task('a1', { status: 'running', startedAt: 1 }),
          a2: task('a2', { status: 'awaiting_user', startedAt: 2 }),
        },
        progressByTask: { a1: { taskId: 'a1', text: '正在改 a.ts', source: 'speech' } },
      });
    });
    render(<SubagentBar conversationId={CONV} />);
    // 同步消息为空，两行全来自 async 源
    expect(screen.getByText('2 个进行中')).toBeTruthy();
    expect(screen.getByText('· 1 个等你确认')).toBeTruthy();

    fireEvent.click(screen.getByText('2 个进行中'));
    expect(screen.getByText('任务a1')).toBeTruthy();
    expect(screen.getByText('正在改 a.ts')).toBeTruthy();
    expect(screen.getByText('任务a2')).toBeTruthy();
    expect(screen.getAllByText('等你确认').length).toBeGreaterThan(0);
  });

  it('只收本对话的 async task：别对话/终态的不进条', () => {
    act(() => {
      useTaskStore.setState({
        tasks: {
          mine: task('mine', { status: 'running', startedAt: 1 }),
          other: task('other', { status: 'running', startedAt: 2, conversationId: 'cnv_elsewhere' }),
          done: task('done', { status: 'done', startedAt: 3 }),
        },
      });
    });
    const { container } = render(<SubagentBar conversationId={CONV} />);
    expect(screen.getByText('1 个进行中')).toBeTruthy();
    expect(container.textContent).not.toContain('任务other');
    expect(container.textContent).not.toContain('任务done');
  });

  it('async task 到终态：原位闪「✓ 完成」，随后退场', () => {
    vi.useFakeTimers();
    act(() => {
      useTaskStore.setState({ tasks: { a1: task('a1', { status: 'running', startedAt: 1 }) } });
    });
    const { container } = render(<SubagentBar conversationId={CONV} />);
    expect(screen.getByText('1 个进行中')).toBeTruthy();

    act(() => {
      useTaskStore.setState({
        tasks: { a1: task('a1', { status: 'done', startedAt: 1, finishedAt: 9, summary: '做完了' }) },
      });
    });
    expect(screen.getByText(/任务a1/)).toBeTruthy();
    expect(screen.getByText(/完成/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(container.firstChild).toBeNull();
  });

  it('排队中的 code 派工（proposal pending、无 task）：显示一行排队行', () => {
    act(() => {
      useTaskStore.setState({ proposalsByConv: { [CONV]: [queuedCodeProposal('p_q1')] } });
    });
    render(<SubagentBar conversationId={CONV} />);
    expect(screen.getByText('1 个进行中')).toBeTruthy();
    fireEvent.click(screen.getByText('1 个进行中'));
    expect(screen.getByText('任务p_q1')).toBeTruthy();
  });

  it('排队 → 运行无缝接管：起跑瞬间（executing + task 出现）无双行、不闪没', () => {
    vi.useFakeTimers();
    // 排队中：只有 proposal（kind=code pending），无 task
    act(() => {
      useTaskStore.setState({ proposalsByConv: { [CONV]: [queuedCodeProposal('p_q2', { title: '任务q2' })] } });
    });
    const { container } = render(<SubagentBar conversationId={CONV} />);
    expect(screen.getByText('1 个进行中')).toBeTruthy();
    fireEvent.click(screen.getByText('1 个进行中'));
    expect(screen.getByText('任务q2')).toBeTruthy();

    // 起跑：proposal 迁 executing（不再 pending）+ task.started 到达。proposalId 一致 → 同一行，无双行。
    act(() => {
      useTaskStore.setState({
        proposalsByConv: { [CONV]: [queuedCodeProposal('p_q2', { title: '任务q2', status: 'executing' })] },
        tasks: { t2: task('t2', { proposalId: 'p_q2', proposalTitle: '任务q2', status: 'running', startedAt: 1 }) },
      });
    });
    // 仍只一行：同 key（p_q2）合并，无双行（展开态保持，行仍显示）
    expect(screen.getAllByText('任务q2')).toHaveLength(1);
    // 不误闪「完成」——起跑不是终态
    expect(screen.queryByText(/完成/)).toBeNull();
    expect(container.firstChild).not.toBeNull();
  });

  it('起跑中间帧：proposal 已 executing、task 未建时行不闪没（方案承诺"executing 不删行"）', () => {
    vi.useFakeTimers();
    // 排队中：只有 proposal（kind=code pending），无 task
    act(() => {
      useTaskStore.setState({ proposalsByConv: { [CONV]: [queuedCodeProposal('p_i1', { title: '任务i1' })] } });
    });
    const { container } = render(<SubagentBar conversationId={CONV} />);
    fireEvent.click(screen.getByText('1 个进行中'));
    expect(screen.getByText('任务i1')).toBeTruthy();

    // 起跑中间帧：proposal 已迁 executing（不再 pending），但 task 尚未到达（createTask 前的 await 窗口）
    act(() => {
      useTaskStore.setState({
        proposalsByConv: { [CONV]: [queuedCodeProposal('p_i1', { title: '任务i1', status: 'executing' })] },
      });
    });
    // 行仍在（executing 也被源2 收），不闪没
    expect(screen.getByText('任务i1')).toBeTruthy();
    expect(container.firstChild).not.toBeNull();
    // 不误闪「完成」——executing 不是终态
    expect(screen.queryByText(/完成/)).toBeNull();

    // task 随后到达 → 同 key 合并，仍一行
    act(() => {
      useTaskStore.setState({
        proposalsByConv: { [CONV]: [queuedCodeProposal('p_i1', { title: '任务i1', status: 'executing' })] },
        tasks: { t1: task('t1', { proposalId: 'p_i1', proposalTitle: '任务i1', status: 'running', startedAt: 1 }) },
      });
    });
    expect(screen.getAllByText('任务i1')).toHaveLength(1);
  });

  it('readonly 挡：code 排队是「真审批」归流内卡，不显示排队行', () => {
    useAgentStore.setState({
      activeAgentId: 'twin',
      agents: [{ id: 'twin', ownerId: 'local-user', name: 'twin', homePath: '/tmp', systemPromptAppend: null, approvalMode: 'readonly', createdAt: 1, avatarPath: null } satisfies Agent],
    });
    act(() => {
      useTaskStore.setState({ proposalsByConv: { [CONV]: [queuedCodeProposal('p_ro')] } });
    });
    const { container } = render(<SubagentBar conversationId={CONV} />);
    // readonly 下 code 排队不归「排队中」行（审批归流内 CodeProposalCard）——条不渲染
    expect(container.firstChild).toBeNull();
  });
});
