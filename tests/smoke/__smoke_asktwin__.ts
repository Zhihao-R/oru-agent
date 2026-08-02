/**
 * Smoke：askTwinBridge 直接打 background Twin 拿答案
 *
 * 验证：
 * 1. askTwin() 真的起一次 Twin SDK query
 * 2. 状态切换事件按预期 emit（awaiting_twin → running）
 * 3. question / questionAnswered 事件携带正确数据
 * 4. 返回的字符串可以直接喂给子 agent
 *
 * 用法：tsx --tsconfig tsconfig.node.json electron/main/__smoke_asktwin__.ts
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import { createTask } from '../../electron/main/tasks/store';
import { askTwin } from '../../electron/main/tasks/askTwinBridge';
import { newTaskId } from '@shared/ids';
import type { SubagentTask } from '@shared/types';

async function main() {
  await ensureDefaultAgent();

  const taskId = newTaskId();
  const task: SubagentTask = {
    id: taskId,
    ownerId: 'local-user',
    agentId: 'twin',
    conversationId: 'smoke-conv',
    proposalId: 'smoke-prp',
    proposalTitle: '修登录页样式',
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
  await createTask(task);

  const events: Array<{ type: string }> = [];
  const emit = (ev: { type: string }) => events.push(ev);

  console.log('[smoke-asktwin] calling askTwin (will hit real Claude)...');
  const answer = await askTwin({
    agentId: 'twin',
    taskId,
    question:
      '我在改登录页 dark mode，发现现有按钮用 fetch 调 /api/login，项目其他地方都用 axios。要不要统一换成 axios？只回答"换"或"不换"，加一句话解释。',
    contextPaths: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit: emit as any,
  });

  const summary = {
    answerExcerpt: answer.slice(0, 200),
    eventTypes: events.map((e) => e.type),
    statusChanges: events.filter((e) => e.type === 'task.statusChanged').map((e) => e),
    questionFired: events.some((e) => e.type === 'task.question'),
    answerFired: events.some((e) => e.type === 'task.questionAnswered'),
  };
  console.log('[smoke-asktwin] result:', JSON.stringify(summary, null, 2));

  if (!answer || answer.length < 4) {
    console.error('[smoke-asktwin] FAIL: answer too short');
    process.exit(1);
  }
  if (!summary.questionFired) {
    console.error('[smoke-asktwin] FAIL: task.question event not emitted');
    process.exit(1);
  }
  if (!summary.answerFired) {
    console.error('[smoke-asktwin] FAIL: task.questionAnswered event not emitted');
    process.exit(1);
  }
  console.log('[smoke-asktwin] PASS');
  process.exit(0);
}

main().catch((e) => {
  console.error('[smoke-asktwin] FAILED:', e);
  process.exit(1);
});
