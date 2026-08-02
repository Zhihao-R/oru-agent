/**
 * 并发写撕裂回归 smoke：验证 atomicStore 的 enqueue 串行 + tmp+rename 真有效。
 *
 * 测试场景：
 * - conversations: 50 条并发 appendMessage（同 conv）
 * - projects: 50 次并发 updateSettings
 *
 * 断言：
 * - config.json 仍可解析
 * - 消息计数 ≥ 50（jsonl 不撕裂）
 * - settings 最后一次 patch 生效（写入串行成功）
 *
 * 没有 atomicStore 前这两个 store 都会撕裂 index.json / config.json，
 * 或者 read-modify-write 互相覆盖丢消息。
 */
import './__smoke_isolate__';
import { appendMessage, createSubConversation, readHistory } from '../../electron/main/conversations/store';
import { updateSettings, getSettings, listProjects } from '../../electron/main/projects/store';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import {
  createTask,
  appendQuestion,
  updateQuestion,
  getQuestions,
} from '../../electron/main/tasks/store';
import type { SubagentTask, TaskQuestion } from '@shared/types';
import { newMessageId } from '@shared/ids';

const RESULTS: { name: string; ok: boolean; msg?: string }[] = [];
function assert(name: string, ok: boolean, msg?: string) {
  RESULTS.push({ name, ok, msg });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${msg ? ' — ' + msg : ''}`);
}

async function main() {
  const agent = await ensureDefaultAgent();
  const conv = await createSubConversation(agent.id, '新对话');

  // 50 条并发 appendMessage：每条独立 id + 文本
  const N = 50;
  const appends = Array.from({ length: N }, (_, i) =>
    appendMessage(agent.id, conv.id, {
      id: newMessageId(),
      conversationId: conv.id,
      role: 'user',
      text: `concurrent-${i}`,
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    }),
  );

  // 同时 50 次 updateSettings：交替 true/false
  const settingsWrites = Array.from({ length: N }, (_, i) =>
    updateSettings({ developer: { debugLogging: i % 2 === 0 } }),
  );

  await Promise.all([...appends, ...settingsWrites]);

  // 最后追加一次 final 串行写入——所有并发完成后入队，必须生效
  // 验证 enqueue 是 FIFO + cache mutation 在锁内不被前面 50 个 task 覆盖
  await updateSettings({ developer: { debugLogging: true } });

  // 验证 1: config.json 可解析（撕裂会 throw）
  try {
    const { projects } = await listProjects();
    assert('listProjects() 不 throw', Array.isArray(projects));
  } catch (e) {
    assert('listProjects() 不 throw', false, (e as Error).message);
  }

  // 验证 2: settings 可读 + last-write-wins（final 写入 true 必须生效）
  try {
    const s = await getSettings();
    assert('getSettings() 不 throw', s !== null && typeof s === 'object');
    assert(
      'settings 最后一次写入生效（last-write-wins）',
      s.developer?.debugLogging === true,
      `got ${JSON.stringify(s.developer)}`,
    );
  } catch (e) {
    assert('getSettings() 不 throw', false, (e as Error).message);
  }

  // 验证 3: 50 条消息全在
  const history = await readHistory(agent.id, conv.id);
  const userMsgs = history.filter((m) => m.role === 'user' && m.text.startsWith('concurrent-'));
  assert(
    `appendMessage 50 并发后 ${userMsgs.length}/${N} 仍在`,
    userMsgs.length === N,
    `got ${userMsgs.length}`,
  );

  // 验证 4: 消息 id 全互不重复
  const ids = new Set(userMsgs.map((m) => m.id));
  assert(`消息 id 互不重复`, ids.size === userMsgs.length, `${ids.size} unique vs ${userMsgs.length}`);

  // ─── tasks/store question RMW 并发场景 ──────────────────────────────
  // appendQuestion / updateQuestion 是典型 read-modify-write：先 readQuestions
  // → 改 → writeQuestions。没有 enqueue 串行时并发会丢追问。
  const task: SubagentTask = {
    id: 'task_concurrent_test',
    ownerId: 'local-user',
    agentId: 'twin',
    conversationId: conv.id,
    proposalId: 'prop_test',
    proposalTitle: 'concurrent test',
    targetProjectId: null,
    status: 'pending',
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

  // 50 并发 appendQuestion——每条独立 id
  const Q = 50;
  const appendsQ = Array.from({ length: Q }, (_, i) => {
    const q: TaskQuestion = {
      id: `q_${i}`,
      taskId: task.id,
      question: `question-${i}`,
      contextPaths: [],
      askedAt: Date.now(),
      answer: null,
      twinProcessedAnswer: null,
      answeredBy: null,
      answeredAt: null,
    };
    return appendQuestion(task.id, q);
  });
  await Promise.all(appendsQ);

  const questions = await getQuestions(task.id);
  assert(
    `appendQuestion ${Q} 并发后 ${questions.length}/${Q} 仍在`,
    questions.length === Q,
    `got ${questions.length}`,
  );
  assert(
    `question id 全互不重复`,
    new Set(questions.map((q) => q.id)).size === questions.length,
    `${new Set(questions.map((q) => q.id)).size} unique`,
  );

  // 50 并发 updateQuestion——所有 question 同时标 answered
  const updatesQ = questions.map((q) =>
    updateQuestion(task.id, q.id, { answer: `ans-${q.id}`, answeredBy: 'user', answeredAt: Date.now() }),
  );
  await Promise.all(updatesQ);

  const final = await getQuestions(task.id);
  const answered = final.filter((q) => q.answer?.startsWith('ans-'));
  assert(
    `updateQuestion ${Q} 并发后全部 answer 落盘`,
    answered.length === Q,
    `got ${answered.length} answered`,
  );

  const passed = RESULTS.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${RESULTS.length} PASSED ===`);
  process.exit(passed === RESULTS.length ? 0 : 1);
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(1);
});
