// @vitest-environment jsdom

/**
 * artifactStore.generateDeck 失败必可见（走查二批该修 4）：
 * - 无活跃对话 → { ok:false, reason } 且**不发** WS 请求（修复前静默 return false，主进程零日志）；
 * - 后端 error → { ok:false, reason: 后端 message }（修复前 catch 吞成 false）；
 * - 派发成功 → 乐观置「排队中」标记；useDeckGenerateState 按 taskStore/标记派生「生成中/排队中」。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useArtifactStore, useDeckGenerateState } from '@/stores/artifactStore';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import type { SubagentTask } from '@shared/types';
import { renderHook } from '@testing-library/react';

function withActiveConversation(): void {
  useAgentStore.setState({ activeAgentId: 'agent_1' } as never);
  useConversationStore.setState({ activeByAgent: { agent_1: 'conv_1' } } as never);
}

function makeTask(partial: Pick<SubagentTask, 'id' | 'status'> & Partial<SubagentTask>): SubagentTask {
  return {
    ownerId: 'local-user',
    agentId: 'agent_1',
    conversationId: 'conv_1',
    proposalId: 'prop_x',
    proposalTitle: '生成 deck',
    targetProjectId: 'prj',
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
    ...partial,
  } satisfies SubagentTask;
}

beforeEach(() => {
  requestMock.mockReset();
  useAgentStore.setState({ activeAgentId: null } as never);
  useConversationStore.setState({ activeByAgent: {} } as never);
  useTaskStore.setState({ tasks: {} });
  useArtifactStore.setState({ generateQueuedByArtifact: {} });
});

describe('generateDeck 失败带原因（该修 4）', () => {
  it('无活跃对话 → ok:false 带原因，且不发 WS 请求', async () => {
    const r = await useArtifactStore.getState().generateDeck('dck_1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('后端 error → ok:false，原因随返回值带出', async () => {
    withActiveConversation();
    requestMock.mockRejectedValue(new Error('这份演示设计正在生成中'));
    const r = await useArtifactStore.getState().generateDeck('dck_1');
    expect(r).toEqual({ ok: false, reason: '这份演示设计正在生成中' });
  });

  it('派发成功 → ok:true 且乐观置「排队中」标记', async () => {
    withActiveConversation();
    requestMock.mockResolvedValue({ type: 'ack' });
    const r = await useArtifactStore.getState().generateDeck('dck_1');
    expect(r.ok).toBe(true);
    expect(typeof useArtifactStore.getState().generateQueuedByArtifact['dck_1']).toBe('number');
  });
});

describe('useDeckGenerateState 派生（生成中/排队中）', () => {
  it('无任务无标记 → null；只有乐观标记 → queued', () => {
    const { result, rerender } = renderHook(() => useDeckGenerateState('dck_1'));
    expect(result.current).toBeNull();
    useArtifactStore.setState({ generateQueuedByArtifact: { dck_1: 1000 } });
    rerender();
    expect(result.current).toBe('queued');
  });

  it('taskStore 有归属本 deck 的活动任务 → running（遮蔽乐观标记）', () => {
    useArtifactStore.setState({ generateQueuedByArtifact: { dck_1: 1000 } });
    useTaskStore.setState({
      tasks: { t1: makeTask({ id: 't1', status: 'running', deckArtifactId: 'dck_1', startedAt: 1000 }) },
    });
    const { result } = renderHook(() => useDeckGenerateState('dck_1'));
    expect(result.current).toBe('running');
  });

  it('任务到终态（startedAt 不早于标记）→ null（任务记录接管，标记不复活）', () => {
    useArtifactStore.setState({ generateQueuedByArtifact: { dck_1: 1000 } });
    useTaskStore.setState({
      tasks: { t1: makeTask({ id: 't1', status: 'done', deckArtifactId: 'dck_1', startedAt: 1000 }) },
    });
    const { result } = renderHook(() => useDeckGenerateState('dck_1'));
    expect(result.current).toBeNull();
  });

  it('再次派发：旧的终态任务（startedAt 早于新标记）不遮蔽新一轮 → queued', () => {
    useArtifactStore.setState({ generateQueuedByArtifact: { dck_1: 2000 } });
    useTaskStore.setState({
      tasks: { t1: makeTask({ id: 't1', status: 'done', deckArtifactId: 'dck_1', startedAt: 1000 }) },
    });
    const { result } = renderHook(() => useDeckGenerateState('dck_1'));
    expect(result.current).toBe('queued');
  });

  it('别的 deck 的任务不影响本 deck', () => {
    useTaskStore.setState({
      tasks: { t1: makeTask({ id: 't1', status: 'running', deckArtifactId: 'dck_other' }) },
    });
    const { result } = renderHook(() => useDeckGenerateState('dck_1'));
    expect(result.current).toBeNull();
  });
});
