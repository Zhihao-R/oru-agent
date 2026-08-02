/**
 * check_subagent_progress 工具回归
 *
 * 核心不变量（对应「subagent 干完了主对话 AI 却不知道」这个原始 bug）：
 * - 终态但未播报的 task（done/failed）→ 现查能看到结果，且就地 markAnnounced（防终态播报重复念）
 * - 在跑的 task（pending/running/awaiting_*）→ 给状态 + 已跑时长 +「最近一次活动」/ 待答追问
 * - 已播报的终态 task → 不再列（避免重复转述）
 * - 本对话无 task → 明确回「没有」，不让模型误以为还在跑而去 list_dir 猜
 * - 只看当前对话的 task（listTasksForConversation 已按 convId 过滤；这里验工具不越界）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubagentTask, TaskQuestion } from '@shared/types';
import { makeToolContext } from '../helpers/toolContext';
import { makeCheckSubagentTasksTool } from '../../electron/main/agent/agentTools/checkTasks';
import { setTasksGateway } from '../../electron/main/agent/tasksGateway';

// mock 锚到真实 store 签名（typeof import）——store 接口变形这里会红，不裸对象蒙混
const listTasksMock =
  vi.fn<(typeof import('../../electron/main/tasks/store'))['listTasksForConversation']>();
const markAnnouncedMock =
  vi.fn<(typeof import('../../electron/main/tasks/store'))['markAnnounced']>();
const getLastProgressMock =
  vi.fn<(typeof import('../../electron/main/tasks/store'))['getLastProgress']>();
const getQuestionsMock =
  vi.fn<(typeof import('../../electron/main/tasks/store'))['getQuestions']>();

const CONV = 'conv-1';
const ctx = makeToolContext({
  conversationId: CONV,
  agentId: 'agent-1',
  ownerId: 'owner-1',
});

function task(over: Partial<SubagentTask> & Pick<SubagentTask, 'id' | 'status'>): SubagentTask {
  return {
    ownerId: 'owner-1',
    agentId: 'agent-1',
    conversationId: CONV,
    proposalId: 'prop-1',
    proposalTitle: '改首页文案',
    targetProjectId: null,
    baselineCommit: null,
    summary: null,
    errorMessage: null,
    startedAt: Date.now() - 90_000, // 默认已跑 1 分 30 秒
    finishedAt: null,
    profileId: 'project-coder',
    endTag: null,
    affectedPaths: [],
    commitsCreated: [],
    announcedAt: null,
    featureBranch: null,
    ...over,
  };
}

function question(over: Partial<TaskQuestion> & Pick<TaskQuestion, 'id' | 'taskId'>): TaskQuestion {
  return {
    question: '要用哪种配色？',
    contextPaths: [],
    askedAt: Date.now(),
    answer: null,
    twinProcessedAnswer: null,
    answeredBy: null,
    answeredAt: null,
    ...over,
  };
}

const tool = makeCheckSubagentTasksTool();
const run = () => tool.execute({}, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  getLastProgressMock.mockResolvedValue(null);
  getQuestionsMock.mockResolvedValue([]);
  markAnnouncedMock.mockResolvedValue();
  setTasksGateway({
    listTasksForConversation: listTasksMock,
    markAnnounced: markAnnouncedMock,
    getLastProgress: getLastProgressMock,
    getQuestions: getQuestionsMock,
  });
});

describe('check_subagent_progress', () => {
  it('本对话无 task → 明确回「没有」，不诱导去猜', async () => {
    listTasksMock.mockResolvedValue([]);
    const r = await run();
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('没有在跑');
    expect(markAnnouncedMock).not.toHaveBeenCalled();
  });

  it('【回归】终态 done 但未播报 → 报「已完成」+ 摘要，并 markAnnounced', async () => {
    listTasksMock.mockResolvedValue([
      task({ id: 't1', status: 'done', summary: '已生成 index.html（135 KB）+ images/ 30 张' }),
    ]);
    const r = await run();
    expect(r.text).toContain('已完成');
    expect(r.text).toContain('135 KB');
    expect(r.text).not.toContain('运行中');
    expect(markAnnouncedMock).toHaveBeenCalledWith('t1');
  });

  it('failed 未播报 → 报失败 + 错误，并 markAnnounced', async () => {
    listTasksMock.mockResolvedValue([
      task({ id: 't2', status: 'failed', errorMessage: 'git 冲突' }),
    ]);
    const r = await run();
    expect(r.text).toContain('失败');
    expect(r.text).toContain('git 冲突');
    expect(markAnnouncedMock).toHaveBeenCalledWith('t2');
  });

  it('已播报的终态 task → 不再列（避免重复转述）', async () => {
    listTasksMock.mockResolvedValue([
      task({ id: 't3', status: 'done', summary: 'done', announcedAt: Date.now() }),
    ]);
    const r = await run();
    expect(r.text).toContain('没有在跑');
    expect(markAnnouncedMock).not.toHaveBeenCalled();
  });

  it('running → 报「运行中」+ 已跑时长 + 最近一次活动；绝不 markAnnounced', async () => {
    listTasksMock.mockResolvedValue([task({ id: 't4', status: 'running' })]);
    getLastProgressMock.mockResolvedValue('调用工具：write_file');
    const r = await run();
    expect(r.text).toContain('运行中');
    expect(r.text).toMatch(/已跑\s*1\s*分/);
    expect(r.text).toContain('调用工具：write_file');
    expect(markAnnouncedMock).not.toHaveBeenCalled();
  });

  it('running 但取不到进度 → 退化成纯状态，不炸', async () => {
    listTasksMock.mockResolvedValue([task({ id: 't5', status: 'running' })]);
    getLastProgressMock.mockResolvedValue(null);
    const r = await run();
    expect(r.text).toContain('运行中');
    expect(r.text).not.toContain('最近');
  });

  it('awaiting_user → 带出待答的那条追问；不去读 getLastProgress', async () => {
    listTasksMock.mockResolvedValue([task({ id: 't6', status: 'awaiting_user' })]);
    getQuestionsMock.mockResolvedValue([
      question({ id: 'q1', taskId: 't6', question: '旧', answeredAt: Date.now(), answeredBy: 'user', answer: '答' }),
      question({ id: 'q2', taskId: 't6', question: '首页标题保留还是改写？' }),
    ]);
    const r = await run();
    expect(r.text).toContain('等待你回答');
    expect(r.text).toContain('首页标题保留还是改写？');
    expect(getLastProgressMock).not.toHaveBeenCalled();
  });

  it('在跑 + 刚结束混合 → 两段都出，终态那条被 markAnnounced', async () => {
    listTasksMock.mockResolvedValue([
      task({ id: 'run', status: 'running' }),
      task({ id: 'fin', status: 'done', summary: '搞定' }),
    ]);
    const r = await run();
    expect(r.text).toContain('【进行中】');
    expect(r.text).toContain('【刚结束');
    expect(markAnnouncedMock).toHaveBeenCalledTimes(1);
    expect(markAnnouncedMock).toHaveBeenCalledWith('fin');
  });

  it('listTasksForConversation 抛错 → 优雅 isError，不让整轮崩', async () => {
    listTasksMock.mockRejectedValue(new Error('fs boom'));
    const r = await run();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('fs boom');
  });
});
