/**
 * Escalate smoke：完整测 askTwin 的"Twin 答不出 → 转用户 → 用户答 → Twin 加工 → 子 agent 拿到"闭环
 *
 * 不打 Claude，用 mock background Twin 模拟两种情况：
 *  - 第 1 次调用：模拟 Twin 决定 escalate（调 escalateHandler）
 *  - 第 2 次调用：模拟 Twin 加工用户回答（输出翻译版）
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import { newTaskId } from '@shared/ids';
import type { SubagentTask } from '@shared/types';
import type { ServerEventPayload } from '@shared/protocol';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { createTask } from '../../electron/main/tasks/store';
import { askTwin, userAnswered } from '../../electron/main/tasks/askTwinBridge';
import { __setRunBackgroundForTest } from '../../electron/main/agent/twinBackgroundQuery';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function makeTask(id: string): SubagentTask {
  return {
    id,
    ownerId: 'local-user',
    agentId: 'twin',
    conversationId: 'smoke-escalate',
    proposalId: 'prp_smoke',
    proposalTitle: 'smoke escalate',
    targetProjectId: null,
    status: 'running',
    baselineCommit: null,
    summary: null,
    errorMessage: null,
    startedAt: Date.now(),
    finishedAt: null,
    profileId: 'project-coder',
    endTag: null,
    affectedPaths: [],
    commitsCreated: [],
    announcedAt: null,
    featureBranch: null,
  };
}

async function main(): Promise<void> {
  console.log('=== escalate smoke ===');
  await ensureDefaultAgent();
  const taskId = newTaskId();
  await createTask(makeTask(taskId));

  let bgCallCount = 0;
  let escalateInvoked = false;
  const userOriginal = '不用换';
  const twinTranslated = '保持现有 fetch 调用，不要替换为 axios';
  const escalatedQuestion: { v: string | null } = { v: null };

  const restore = __setRunBackgroundForTest(async (args) => {
    bgCallCount++;
    if (bgCallCount === 1) {
      // 第一次：模拟 Twin 决定 escalate（实际 background Twin 会调 escalate_to_user 工具）
      if (args.escalateHandler && args.taskId) {
        escalateInvoked = true;
        escalatedQuestion.v = args.prompt; // 记录 escalate 时复述给用户的话
        await args.escalateHandler(args.taskId, '我答不出，转你来决定: ' + args.prompt.slice(0, 50));
      }
      return { resultText: '已转交给用户', isError: false };
    }
    // 第二次：用户回答后的"加工"
    return { resultText: twinTranslated, isError: false };
  });

  const events: ServerEventPayload[] = [];
  const emit = (ev: ServerEventPayload) => events.push(ev);

  // 启动 askTwin —— 它会跑到 escalate 路径并阻塞等用户答
  const askPromise = askTwin({
    agentId: 'twin',
    taskId,
    question: '改 fetch 为 axios 吗？',
    contextPaths: [],
    emit,
  });

  // 等 escalate 触发（异步链路需要一点时间）
  await new Promise((r) => setTimeout(r, 200));

  assert(escalateInvoked, 'escalateHandler 被调用');
  assert(
    events.some((e) => e.type === 'task.statusChanged' && e.status === 'awaiting_twin'),
    '事件: status awaiting_twin 已 emit',
  );
  assert(
    events.some((e) => e.type === 'task.statusChanged' && e.status === 'awaiting_user'),
    '事件: status awaiting_user 已 emit',
  );
  assert(
    events.some((e) => e.type === 'task.question'),
    '事件: task.question 已 emit',
  );

  const qEvent = events.find((e): e is Extract<ServerEventPayload, { type: 'task.question' }> => e.type === 'task.question');
  assert(qEvent !== undefined, 'task.question 事件存在');
  if (!qEvent) {
    restore();
    process.exit(1);
  }
  const questionId = qEvent.question.id;

  // 用户回答 → 应触发 askTwin 的 promise resolve 链路
  const ok = userAnswered(taskId, questionId, userOriginal);
  assert(ok, 'userAnswered 返回 true（命中 pending promise）');

  // 等 askTwin 走完（包括 Twin 加工的第二次后台 query）
  const finalAnswer = await askPromise;

  assert(bgCallCount === 2, `background Twin 被调 2 次（escalate + 加工）`, `actual: ${bgCallCount}`);
  assert(finalAnswer === twinTranslated, '子 agent 最终拿到的是 Twin 加工版而非用户原话', `got: ${finalAnswer}`);

  // questionAnswered 事件应携带 user 原话和 twin 加工版
  const answeredEvent = events.find(
    (e): e is Extract<ServerEventPayload, { type: 'task.questionAnswered' }> => e.type === 'task.questionAnswered',
  );
  assert(answeredEvent !== undefined, 'task.questionAnswered 事件存在');
  if (answeredEvent) {
    assert(answeredEvent.question.answer === userOriginal, 'answer 字段是用户原话', String(answeredEvent.question.answer));
    assert(
      answeredEvent.question.twinProcessedAnswer === twinTranslated,
      'twinProcessedAnswer 字段是 Twin 加工版',
      String(answeredEvent.question.twinProcessedAnswer),
    );
    assert(answeredEvent.question.answeredBy === 'user', 'answeredBy = user');
  }

  // task 应该切回 running
  const finalStatusChange = events
    .filter((e): e is Extract<ServerEventPayload, { type: 'task.statusChanged' }> => e.type === 'task.statusChanged')
    .pop();
  assert(finalStatusChange?.status === 'running', `task 最终切回 running`, `last status: ${finalStatusChange?.status}`);

  restore();

  const failed = RESULTS.filter((r) => !r.ok);
  console.log('---');
  console.log(`total: ${RESULTS.length}, pass: ${RESULTS.length - failed.length}, fail: ${failed.length}`);
  if (failed.length > 0) {
    console.error('FAILED:', JSON.stringify(failed, null, 2));
    process.exit(1);
  }
  console.log('ALL PASS');
  process.exit(0);
}

main().catch(async (e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
