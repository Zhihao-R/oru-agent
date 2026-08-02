/**
 * taskStore 合约测试
 *
 * 测试目标：把 store 当成"WS 事件 → UI 状态"的纯函数集合验证。
 * 不渲染任何组件、不动 ws、不动后端——只输入"事件序列"，断言"store 内部状态"。
 *
 * 这层测试在 UI 频繁变动时仍稳定，因为合约的输入（WS 协议事件）和
 * 输出（store state shape）变动远小于 UI 选择器。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useTaskStore } from '@/stores/taskStore';
import type { ActionProposal, SubagentTask, TaskProgress, TaskQuestion } from '@shared/types';

function makeProposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    kind: 'code',
    id: 'prp_1',
    ownerId: 'local-user',
    conversationId: 'cnv_a',
    status: 'pending',
    title: 'test proposal',
    description: 'desc',
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
    id: 'tsk_1',
    agentId: 'twin',
    conversationId: 'cnv_a',
    proposalId: 'prp_1',
    proposalTitle: 'test',
    targetProjectId: 'prj_1',
    status: 'running',
    baselineCommit: 'abc123',
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

function makeQuestion(overrides: Partial<TaskQuestion> = {}): TaskQuestion {
  return {
    id: 'qst_1',
    taskId: 'tsk_1',
    question: 'what?',
    contextPaths: [],
    askedAt: 2000,
    answer: null,
    twinProcessedAnswer: null,
    answeredBy: null,
    answeredAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  // 每个 case 重置 store 到初始
  useTaskStore.setState({
    tasks: {},
    proposalsByConv: {},
    progressByTask: {},
    questionsByTask: {},
    expandedCards: new Set<string>(),
    justFinishedTaskId: null,
  });
});

describe('proposals', () => {
  it('addProposal 按 conversationId 分桶', () => {
    const s = useTaskStore.getState();
    s.addProposal(makeProposal({ id: 'p1', conversationId: 'cnv_a' }));
    s.addProposal(makeProposal({ id: 'p2', conversationId: 'cnv_a' }));
    s.addProposal(makeProposal({ id: 'p3', conversationId: 'cnv_b' }));
    const state = useTaskStore.getState();
    expect(state.proposalsByConv['cnv_a'].map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(state.proposalsByConv['cnv_b'].map((p) => p.id)).toEqual(['p3']);
  });

  it('removeProposal 跨 conversation 删除', () => {
    const s = useTaskStore.getState();
    s.addProposal(makeProposal({ id: 'p1', conversationId: 'cnv_a' }));
    s.addProposal(makeProposal({ id: 'p2', conversationId: 'cnv_b' }));
    s.removeProposal('p1');
    const state = useTaskStore.getState();
    expect(state.proposalsByConv['cnv_a']).toBeUndefined();
    expect(state.proposalsByConv['cnv_b'].map((p) => p.id)).toEqual(['p2']);
  });

});

describe('task lifecycle', () => {
  it('upsertTask 新增和覆盖', () => {
    const s = useTaskStore.getState();
    s.upsertTask(makeTask({ id: 't1', status: 'pending' }));
    expect(useTaskStore.getState().tasks['t1'].status).toBe('pending');
    s.upsertTask(makeTask({ id: 't1', status: 'running' }));
    expect(useTaskStore.getState().tasks['t1'].status).toBe('running');
  });

  it('setStatus 在已存在 task 上切换状态', () => {
    const s = useTaskStore.getState();
    s.upsertTask(makeTask({ id: 't1', status: 'running' }));
    s.setStatus('t1', 'awaiting_twin');
    expect(useTaskStore.getState().tasks['t1'].status).toBe('awaiting_twin');
    s.setStatus('t1', 'awaiting_user');
    expect(useTaskStore.getState().tasks['t1'].status).toBe('awaiting_user');
  });

  it('setStatus 对不存在的 task 是 no-op，不会创建空 task', () => {
    const s = useTaskStore.getState();
    s.setStatus('t-ghost', 'running');
    expect(useTaskStore.getState().tasks['t-ghost']).toBeUndefined();
  });

  it('markDone 写状态 + summary + justFinishedTaskId（用于 AgentChip 闪绿）', () => {
    const s = useTaskStore.getState();
    s.upsertTask(makeTask({ id: 't1', status: 'running' }));
    s.markDone('t1', 'all good');
    const state = useTaskStore.getState();
    expect(state.tasks['t1'].status).toBe('done');
    expect(state.tasks['t1'].summary).toBe('all good');
    expect(state.justFinishedTaskId).toBe('t1');
  });

  it('markFailed 写 errorMessage + status', () => {
    const s = useTaskStore.getState();
    s.upsertTask(makeTask({ id: 't1', status: 'running' }));
    s.markFailed('t1', 'oops');
    expect(useTaskStore.getState().tasks['t1'].status).toBe('failed');
    expect(useTaskStore.getState().tasks['t1'].errorMessage).toBe('oops');
  });
});

describe('questions', () => {
  it('addQuestion 追加；同 id 二次 add 替换（去重）', () => {
    const s = useTaskStore.getState();
    s.addQuestion('t1', makeQuestion({ id: 'q1', question: 'v1' }));
    s.addQuestion('t1', makeQuestion({ id: 'q2', question: 'v2' }));
    s.addQuestion('t1', makeQuestion({ id: 'q1', question: 'v1-updated' }));
    const list = useTaskStore.getState().questionsByTask['t1'];
    expect(list.map((q) => q.id)).toEqual(['q2', 'q1']);
    expect(list.find((q) => q.id === 'q1')?.question).toBe('v1-updated');
  });

  it('updateQuestion 找不到时退化为追加（防丢消息）', () => {
    const s = useTaskStore.getState();
    s.updateQuestion('t1', makeQuestion({ id: 'q1', answeredBy: 'twin' }));
    const list = useTaskStore.getState().questionsByTask['t1'];
    expect(list?.length).toBe(1);
    expect(list?.[0].answeredBy).toBe('twin');
  });

  it('updateQuestion 在已存在的 question 上写 answeredBy/answer/twinProcessedAnswer', () => {
    const s = useTaskStore.getState();
    s.addQuestion('t1', makeQuestion({ id: 'q1' }));
    s.updateQuestion('t1', makeQuestion({
      id: 'q1',
      answer: '用户原话',
      twinProcessedAnswer: 'twin 加工后',
      answeredBy: 'user',
      answeredAt: 3000,
    }));
    const q = useTaskStore.getState().questionsByTask['t1'].find((x) => x.id === 'q1');
    expect(q?.answer).toBe('用户原话');
    expect(q?.twinProcessedAnswer).toBe('twin 加工后');
    expect(q?.answeredBy).toBe('user');
    expect(q?.answeredAt).toBe(3000);
  });
});

describe('progress', () => {
  it('setProgress 按 taskId 覆盖最新进度', () => {
    const s = useTaskStore.getState();
    const p1: TaskProgress = { taskId: 't1', text: '读取 a.ts' };
    const p2: TaskProgress = { taskId: 't1', text: '改 a.ts' };
    s.setProgress(p1);
    s.setProgress(p2);
    expect(useTaskStore.getState().progressByTask['t1'].text).toBe('改 a.ts');
  });
});

describe('expandedCards', () => {
  it('toggleExpanded 添加和移除', () => {
    const s = useTaskStore.getState();
    s.toggleExpanded('t1');
    expect(useTaskStore.getState().expandedCards.has('t1')).toBe(true);
    s.toggleExpanded('t1');
    expect(useTaskStore.getState().expandedCards.has('t1')).toBe(false);
  });

  it('setExpanded 显式设值（EscalationBanner 跳转用）', () => {
    const s = useTaskStore.getState();
    s.setExpanded('t1', true);
    expect(useTaskStore.getState().expandedCards.has('t1')).toBe(true);
    s.setExpanded('t1', false);
    expect(useTaskStore.getState().expandedCards.has('t1')).toBe(false);
  });
});

describe('selectors', () => {
  it('runningTask 在多个进行中里返回 startedAt 最大的', () => {
    const s = useTaskStore.getState();
    s.upsertTask(makeTask({ id: 't1', status: 'running', startedAt: 1000 }));
    s.upsertTask(makeTask({ id: 't2', status: 'running', startedAt: 2000 }));
    s.upsertTask(makeTask({ id: 't3', status: 'done', startedAt: 3000 }));
    expect(useTaskStore.getState().runningTask()?.id).toBe('t2');
  });

  it('runningTask 把 awaiting_twin / awaiting_user / pending 都算进行中', () => {
    const s = useTaskStore.getState();
    s.upsertTask(makeTask({ id: 't1', status: 'awaiting_twin', startedAt: 1000 }));
    s.upsertTask(makeTask({ id: 't2', status: 'awaiting_user', startedAt: 2000 }));
    s.upsertTask(makeTask({ id: 't3', status: 'pending', startedAt: 3000 }));
    expect(useTaskStore.getState().runningTask()?.id).toBe('t3');
  });

  it('runningTask 没有进行中的返回 null', () => {
    const s = useTaskStore.getState();
    s.upsertTask(makeTask({ id: 't1', status: 'done' }));
    s.upsertTask(makeTask({ id: 't2', status: 'failed' }));
    expect(useTaskStore.getState().runningTask()).toBeNull();
  });

  it('escalatedTasks 跨 conversation 返回所有 awaiting_user', () => {
    const s = useTaskStore.getState();
    s.upsertTask(makeTask({ id: 't1', conversationId: 'cnv_a', status: 'awaiting_user' }));
    s.upsertTask(makeTask({ id: 't2', conversationId: 'cnv_b', status: 'awaiting_user' }));
    s.upsertTask(makeTask({ id: 't3', conversationId: 'cnv_a', status: 'running' }));
    const ids = useTaskStore.getState().escalatedTasks().map((t) => t.id).sort();
    expect(ids).toEqual(['t1', 't2']);
  });
});

// ─── 端到端事件序列：模拟一次 ask_twin escalate 流程 ─────────────────

describe('integrated event sequences', () => {
  it('完整 escalate 闭环：proposal → task → question → escalate → answered', () => {
    const s = useTaskStore.getState();
    // 1. Twin propose
    s.addProposal(makeProposal({ id: 'p1', conversationId: 'cnv_a' }));
    expect(useTaskStore.getState().proposalsByConv['cnv_a']?.length).toBe(1);

    // 2. task started
    s.upsertTask(makeTask({ id: 't1', proposalId: 'p1', status: 'running' }));

    // 3. 子 agent ask_twin → 后端切 awaiting_twin + emit task.question
    s.setStatus('t1', 'awaiting_twin');
    s.addQuestion('t1', makeQuestion({ id: 'q1', question: '要不要包括测试文件?' }));

    // 4. Twin 答不出 → 切 awaiting_user
    s.setStatus('t1', 'awaiting_user');
    expect(useTaskStore.getState().escalatedTasks().map((t) => t.id)).toEqual(['t1']);

    // 5. 用户回答 → questionAnswered + 切回 running
    s.updateQuestion('t1', makeQuestion({
      id: 'q1',
      question: '要不要包括测试文件?',
      answer: '不用',
      twinProcessedAnswer: '跳过 *.test.ts 文件',
      answeredBy: 'user',
      answeredAt: 5000,
    }));
    s.setStatus('t1', 'running');
    expect(useTaskStore.getState().escalatedTasks()).toHaveLength(0);
    expect(useTaskStore.getState().tasks['t1'].status).toBe('running');

    // 6. task done
    s.markDone('t1', '改完了');
    expect(useTaskStore.getState().tasks['t1'].status).toBe('done');
    expect(useTaskStore.getState().justFinishedTaskId).toBe('t1');

    // 7. UI 渲染 task-report 后会 removeProposal（App.tsx 的 chat.taskReport 处理逻辑）
    s.removeProposal('p1');
    expect(useTaskStore.getState().proposalsByConv['cnv_a']).toBeUndefined();
  });
});

describe('对话未读派生（C 块：哪个对话有待审批 + 批一张只递减不清全部）', () => {
  // 对话未读徽标 = 该对话里 pending 且 triggeredBySubagent 的待批卡数（ConversationList 的派生口径）。
  const unread = (convId: string): number =>
    (useTaskStore.getState().proposalsByConv[convId] ?? []).filter(
      (p) => p.status === 'pending' && p.triggeredBySubagent,
    ).length;

  it('同一后台任务并发两张待批卡：批一张只递减一张，另一张仍计数', () => {
    const s = useTaskStore.getState();
    const sub = { taskId: 'tsk_X', description: '建目录+提交' };
    s.addProposal(makeProposal({ id: 'c1', kind: 'bash', conversationId: 'cnv_a', triggeredBySubagent: sub }));
    s.addProposal(makeProposal({ id: 'c2', kind: 'bash', conversationId: 'cnv_a', triggeredBySubagent: sub }));
    expect(unread('cnv_a')).toBe(2);

    // 批准 c1（proposal.statusChanged → updateProposalStatus）→ 未读递减为 1，不清空
    s.updateProposalStatus('c1', 'executed', Date.now());
    expect(unread('cnv_a')).toBe(1);

    s.updateProposalStatus('c2', 'rejected', Date.now());
    expect(unread('cnv_a')).toBe(0);
  });

  it('未读按对话隔离 + 不计非 subagent 卡', () => {
    const s = useTaskStore.getState();
    s.addProposal(makeProposal({ id: 'a1', kind: 'bash', conversationId: 'cnv_a', triggeredBySubagent: { taskId: 'tA', description: 'x' } }));
    s.addProposal(makeProposal({ id: 'b1', kind: 'bash', conversationId: 'cnv_b', triggeredBySubagent: { taskId: 'tB', description: 'y' } }));
    s.addProposal(makeProposal({ id: 'm1', kind: 'bash', conversationId: 'cnv_a' })); // 主对话自己的卡（无 triggeredBySubagent）→ 不计
    expect(unread('cnv_a')).toBe(1);
    expect(unread('cnv_b')).toBe(1);
  });
});
