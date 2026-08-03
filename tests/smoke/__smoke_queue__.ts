/**
 * Queue smoke：去串行后全部并行（2026-08-03 async-subagent-de-serial-plan review-rev 2）
 * 原「同 projectKey 串行」断言随裁决删除——同项目派工并行起跑，不再按项目排队。
 * 不打 Claude，用 mock runFn。验目标问题本身：同一项目 N 个 async 派工同时起跑（不串行）。
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import type { CodeActionProposal } from '@shared/types';
import { newProposalId, newConversationId } from '@shared/ids';

// 主对话已取消——mock proposal 的 conversationId 用一个普通 sub 风格 id（queue mock runFn 不读它）
const CONV_ID = newConversationId();
import { enqueue, __setRunFnForTest } from '../../electron/main/tasks/queue';
import { __resetActiveTasksForTest } from '../../electron/main/tasks/subagentRunner';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];

function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

function makeProposal(targetProjectId: string | null, label: string): CodeActionProposal {
  return {
    kind: 'code',
    status: 'pending',
    id: newProposalId(),
    ownerId: 'local-user',
    conversationId: CONV_ID,
    title: label,
    description: label,
    targetProjectId,
    risk: 'low',
    rollbackable: true,
    rawPlan: label,
    createdAt: Date.now(),
    profileId: 'project-coder',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 测试 1（目标问题本身）：同项目 N 个派工并行起跑，不串行 ──────────────

async function testSameProjectParallel(): Promise<void> {
  __resetActiveTasksForTest();
  let inflight = 0;
  let maxInflight = 0;
  const restore = __setRunFnForTest(async (item) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await delay(80);
    inflight--;
  });

  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', 'A'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', 'B'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', 'C'), emit: () => undefined });

  await delay(400);
  restore();

  assert(maxInflight === 3, 'same project: 3 concurrent (去串行并行)', `got ${maxInflight}`);
}

// ─── 测试 2：跨项目并行（原有语义保留）──────────────────────────────────

async function testCrossProjectParallel(): Promise<void> {
  __resetActiveTasksForTest();
  let inflight = 0;
  let maxInflight = 0;
  const starts: string[] = [];
  const restore = __setRunFnForTest(async (item) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    starts.push(item.proposal.title);
    await delay(60);
    inflight--;
  });

  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', 'P1A'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_2', 'P2A'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_3', 'P3A'), emit: () => undefined });

  await delay(120);
  restore();

  assert(maxInflight === 3, 'cross project: max concurrency = 3', `got ${maxInflight}`);
  assert(starts.length === 3, 'cross project: all 3 started', `got ${starts.length}`);
}

// ─── 测试 3：混合——同一项目也并行（prj_1 三个并发、prj_2 两个并发）──────

async function testMixed(): Promise<void> {
  __resetActiveTasksForTest();
  const inflightByKey = new Map<string, number>();
  const maxInflightByKey = new Map<string, number>();
  const restore = __setRunFnForTest(async (item) => {
    const k = item.proposal.targetProjectId ?? 'twin-home';
    inflightByKey.set(k, (inflightByKey.get(k) ?? 0) + 1);
    maxInflightByKey.set(k, Math.max(maxInflightByKey.get(k) ?? 0, inflightByKey.get(k) ?? 0));
    await delay(50);
    inflightByKey.set(k, (inflightByKey.get(k) ?? 1) - 1);
  });

  // P1: 3 个；P2: 2 个——去串行后各自内部也并行
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', '1A'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', '1B'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', '1C'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_2', '2A'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_2', '2B'), emit: () => undefined });

  await delay(400);
  restore();

  assert(
    maxInflightByKey.get('prj_1') === 3,
    'mixed: prj_1 max concurrency = 3（同项目并行）',
    `got ${maxInflightByKey.get('prj_1')}`,
  );
  assert(
    maxInflightByKey.get('prj_2') === 2,
    'mixed: prj_2 max concurrency = 2（同项目并行）',
    `got ${maxInflightByKey.get('prj_2')}`,
  );
}

// ─── 测试 4：twin-home（targetProjectId=null）照常派，与项目任务并行 ──────

async function testTwinHome(): Promise<void> {
  __resetActiveTasksForTest();
  const started: string[] = [];
  const restore = __setRunFnForTest(async (item) => {
    started.push(item.proposal.title);
    await delay(50);
  });

  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', 'P1'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal(null, 'HOME'), emit: () => undefined });

  await delay(120);
  restore();

  assert(started.length === 2, 'twin-home: home + project both dispatched', `got ${JSON.stringify(started)}`);
}

async function main(): Promise<void> {
  console.log('=== queue smoke（去串行） ===');
  await testSameProjectParallel();
  await testCrossProjectParallel();
  await testMixed();
  await testTwinHome();
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

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
