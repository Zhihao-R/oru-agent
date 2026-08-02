/**
 * Queue smoke：验证同 projectKey 串行 / 跨 projectKey 并行
 * 不打 Claude，用 mock runFn
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import type { CodeActionProposal } from '@shared/types';
import { newProposalId, newConversationId } from '@shared/ids';

// 主对话已取消——mock proposal 的 conversationId 用一个普通 sub 风格 id（queue mock runFn 不读它）
const CONV_ID = newConversationId();
import { enqueue, __setRunFnForTest, __resetQueuesForTest } from '../../electron/main/tasks/queue';

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

// ─── 测试 1：同 projectKey 严格串行 ──────────────────────────────────

async function testSameKeySerial(): Promise<void> {
  __resetQueuesForTest();
  const order: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const restore = __setRunFnForTest(async (item) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    order.push(`start:${item.proposal.title}`);
    await delay(80);
    order.push(`end:${item.proposal.title}`);
    inflight--;
  });

  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', 'A'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', 'B'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', 'C'), emit: () => undefined });

  // 等到所有跑完
  await delay(400);
  restore();

  assert(maxInflight === 1, 'same project: max concurrency = 1', `got ${maxInflight}`);
  assert(
    JSON.stringify(order) ===
      JSON.stringify(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']),
    'same project: A→B→C strict order',
    JSON.stringify(order),
  );
}

// ─── 测试 2：跨 projectKey 并行 ──────────────────────────────────────

async function testCrossKeyParallel(): Promise<void> {
  __resetQueuesForTest();
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

// ─── 测试 3：混合（同项目串 + 跨项目并） ─────────────────────────────

async function testMixed(): Promise<void> {
  __resetQueuesForTest();
  const inflightByKey = new Map<string, number>();
  const maxInflightByKey = new Map<string, number>();
  const restore = __setRunFnForTest(async (item) => {
    const k = item.proposal.targetProjectId ?? 'twin-home';
    inflightByKey.set(k, (inflightByKey.get(k) ?? 0) + 1);
    maxInflightByKey.set(k, Math.max(maxInflightByKey.get(k) ?? 0, inflightByKey.get(k) ?? 0));
    await delay(50);
    inflightByKey.set(k, (inflightByKey.get(k) ?? 1) - 1);
  });

  // P1: 3 个；P2: 2 个
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', '1A'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', '1B'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', '1C'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_2', '2A'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_2', '2B'), emit: () => undefined });

  await delay(400);
  restore();

  assert(
    maxInflightByKey.get('prj_1') === 1,
    'mixed: prj_1 max concurrency = 1',
    `got ${maxInflightByKey.get('prj_1')}`,
  );
  assert(
    maxInflightByKey.get('prj_2') === 1,
    'mixed: prj_2 max concurrency = 1',
    `got ${maxInflightByKey.get('prj_2')}`,
  );
}

// ─── 测试 4：twin-home（targetProjectId=null）独立 key ────────────────

async function testTwinHomeKey(): Promise<void> {
  __resetQueuesForTest();
  const inflightByKey = new Map<string, number>();
  const maxInflightByKey = new Map<string, number>();
  const restore = __setRunFnForTest(async (item) => {
    const k = item.proposal.targetProjectId ?? 'twin-home';
    inflightByKey.set(k, (inflightByKey.get(k) ?? 0) + 1);
    maxInflightByKey.set(k, Math.max(maxInflightByKey.get(k) ?? 0, inflightByKey.get(k) ?? 0));
    await delay(50);
    inflightByKey.set(k, (inflightByKey.get(k) ?? 1) - 1);
  });

  // 1 个项目 + 1 个 home → 应该并行
  enqueue({ agentId: 'twin', proposal: makeProposal('prj_1', 'P1'), emit: () => undefined });
  enqueue({ agentId: 'twin', proposal: makeProposal(null, 'HOME'), emit: () => undefined });

  await delay(120);
  restore();

  const totalMax = (maxInflightByKey.get('prj_1') ?? 0) + (maxInflightByKey.get('twin-home') ?? 0);
  assert(totalMax === 2, 'twin-home: home + project run in parallel', `keys: ${JSON.stringify([...maxInflightByKey.entries()])}`);
}

async function main(): Promise<void> {
  console.log('=== queue smoke ===');
  await testSameKeySerial();
  await testCrossKeyParallel();
  await testMixed();
  await testTwinHomeKey();
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
