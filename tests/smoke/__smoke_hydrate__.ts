/**
 * Hydrate smoke：验证老格式 SubagentTask JSON 反序列化时，
 * 所有 v2 新字段被正确填默认值，不崩、不丢已有字段
 *
 * 模拟场景：用户从 v1 升级到 v2，老 task json 是旧字段集
 * 当 store.getTask 读它时，期望返回完整的 v2 SubagentTask（新字段填默认）
 *
 * 不打 Claude，纯 fs + JSON
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { newTaskId } from '@shared/ids';
import { getTask } from '../../electron/main/tasks/store';
import { tasksDir as buildTasksDir } from '../../electron/main/runtime/paths';
import { LOCAL_USER_ID } from '../../electron/main/identity/getCurrentOwnerId';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function tasksDir(): string {
  return buildTasksDir(LOCAL_USER_ID);
}

async function writeRaw(taskId: string, raw: object): Promise<string> {
  const dir = tasksDir();
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, `${taskId}.json`);
  await fs.writeFile(file, JSON.stringify(raw, null, 2), 'utf-8');
  return file;
}

async function cleanup(taskId: string): Promise<void> {
  const dir = tasksDir();
  for (const ext of ['.json', '.jsonl', '.questions.json']) {
    try {
      await fs.unlink(join(dir, `${taskId}${ext}`));
    } catch {
      // ignore
    }
  }
}

async function main(): Promise<void> {
  console.log('=== hydrate smoke ===');

  // ─── case 1：完整 v1 task（含原 v1 字段，缺所有 v2 字段）───
  const id1 = newTaskId();
  await writeRaw(id1, {
    id: id1,
    agentId: 'twin',
    conversationId: 'cnv_v1',
    proposalId: 'prp_old',
    proposalTitle: 'v1 老 task',
    targetProjectId: 'prj_old',
    status: 'done',
    baselineCommit: 'abc1234',
    summary: 'v1 完成',
    errorMessage: null,
    startedAt: 1000,
    finishedAt: 2000,
    // 缺：profileId, endTag, affectedPaths, commitsCreated, announcedAt, featureBranch
  });
  const t1 = await getTask(id1);
  assert(t1 !== null, 'v1 老 task 反序列化不返回 null');
  assert(t1?.id === id1, 'id 保留');
  assert(t1?.proposalTitle === 'v1 老 task', 'proposalTitle 保留');
  assert(t1?.summary === 'v1 完成', 'summary 保留');
  assert(t1?.profileId === 'project-coder', 'profileId 默认填 project-coder', t1?.profileId);
  assert(t1?.endTag === null, 'endTag 默认填 null');
  assert(Array.isArray(t1?.affectedPaths) && t1.affectedPaths.length === 0, 'affectedPaths 默认 []');
  assert(Array.isArray(t1?.commitsCreated) && t1.commitsCreated.length === 0, 'commitsCreated 默认 []');
  assert(t1?.announcedAt === null, 'announcedAt 默认 null');
  assert(t1?.featureBranch === null, 'featureBranch 默认 null');

  // ─── case 2：极简残缺数据（只有 id）→ hydrate 不应崩 ───
  const id2 = newTaskId();
  await writeRaw(id2, { id: id2 });
  const t2 = await getTask(id2);
  assert(t2 !== null, '残缺 task（只有 id）也能反序列化');
  assert(t2?.proposalTitle === '(无标题)', '缺 proposalTitle 给占位文案', t2?.proposalTitle);
  assert(t2?.status === 'pending', '缺 status 默认 pending', t2?.status);
  assert(t2?.agentId === 'twin', 'agentId 默认 twin', t2?.agentId);

  // ─── case 3：损坏的 JSON → getTask 返回 null（不崩进程）───
  const id3 = newTaskId();
  const dir = tasksDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, `${id3}.json`), 'not valid json {{{', 'utf-8');
  const t3 = await getTask(id3);
  assert(t3 === null, '损坏 JSON 不抛异常，返回 null');

  // ─── case 4：v2 完整数据原样回（没破坏）───
  const id4 = newTaskId();
  await writeRaw(id4, {
    id: id4,
    agentId: 'twin',
    conversationId: 'cnv_v2',
    proposalId: 'prp_v2',
    proposalTitle: 'v2 完整',
    targetProjectId: 'prj_v2',
    status: 'rolled_back',
    baselineCommit: 'def5678',
    summary: 'v2 全字段',
    errorMessage: null,
    startedAt: 3000,
    finishedAt: 4000,
    profileId: 'tester',
    endTag: 'oru/end-x',
    affectedPaths: ['a.ts', 'b.ts'],
    commitsCreated: ['c1', 'c2'],
    announcedAt: 5000,
    featureBranch: 'oru/feature-x',
  });
  const t4 = await getTask(id4);
  assert(t4?.profileId === 'tester', 'v2 已有 profileId 不被覆盖');
  assert(t4?.endTag === 'oru/end-x', 'v2 已有 endTag 不被覆盖');
  assert(JSON.stringify(t4?.affectedPaths) === '["a.ts","b.ts"]', 'v2 affectedPaths 不被覆盖');
  assert(JSON.stringify(t4?.commitsCreated) === '["c1","c2"]', 'v2 commitsCreated 不被覆盖');
  assert(t4?.announcedAt === 5000, 'v2 announcedAt 不被覆盖');
  assert(t4?.featureBranch === 'oru/feature-x', 'v2 featureBranch 不被覆盖');
  assert(t4?.status === 'rolled_back', 'v2 status enum 新值（rolled_back）保留');

  // ─── 清理 ───
  await cleanup(id1);
  await cleanup(id2);
  await cleanup(id3);
  await cleanup(id4);

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
