/**
 * Rollback smoke：用真 git 仓 + 合成 SubagentTask，覆盖核心 rollback 路径
 * 不打 Claude，纯 git + 文件系统操作
 *
 * 覆盖：
 *  1. 跑完没 commit + 撤回（用 git checkout 反向应用 affectedPaths）
 *  2. 跑完已 commit + 撤回（git revert）
 *  3. 用户改别的文件 → 撤回 task A 不动 B（精确路径）
 *  4. 用户改同文件 → 触发 conflictPaths
 *  5. task 新建文件 → 撤回时删除
 *  6. redo rollback（preRollbackTag 恢复）
 */
import './__smoke_isolate__'; // 必须第一行：把 ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { newTaskId } from '@shared/ids';
import type { SubagentTask } from '@shared/types';
import { addProject } from '../../electron/main/projects/store';
import { createTask } from '../../electron/main/tasks/store';
import { rollbackTask, redoRollback } from '../../electron/main/git/rollback';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];

function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function makeRepo(prefix: string): Promise<string> {
  const path = join(tmpdir(), `oru-rb-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  await fs.mkdir(path, { recursive: true });
  const g = simpleGit({ baseDir: path });
  await g.init();
  await g.addConfig('user.email', 'test@oru.local', false, 'local');
  await g.addConfig('user.name', 'oru-test', false, 'local');
  // 关闭 commit signing，避免本机 GPG 配置干扰
  await g.addConfig('commit.gpgsign', 'false', false, 'local');
  return path;
}

async function commit(repo: string, msg: string): Promise<string> {
  const g = simpleGit({ baseDir: repo });
  await g.add('.');
  await g.commit(msg);
  return (await g.revparse(['HEAD'])).trim();
}

async function tagAt(repo: string, tag: string, ref: string): Promise<void> {
  const g = simpleGit({ baseDir: repo });
  await g.tag([tag, ref]);
}

function makeTask(args: {
  taskId: string;
  projectId: string;
  baselineCommit: string;
  endTag: string | null;
  affectedPaths: string[];
  commitsCreated: string[];
  status?: SubagentTask['status'];
}): SubagentTask {
  return {
    id: args.taskId,
    ownerId: 'local-user',
    agentId: 'twin',
    conversationId: 'cnv_smoke',
    proposalId: 'prp_smoke_' + args.taskId,
    proposalTitle: `smoke ${args.taskId}`,
    targetProjectId: args.projectId,
    status: args.status ?? 'done',
    baselineCommit: args.baselineCommit,
    summary: 'smoke',
    errorMessage: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    profileId: 'project-coder',
    endTag: args.endTag,
    affectedPaths: args.affectedPaths,
    commitsCreated: args.commitsCreated,
    announcedAt: null,
    featureBranch: null,
  };
}

// ─── 路径 1：没 commit，反向 checkout ─────────────────────────────────

async function pathNoCommit(): Promise<void> {
  const repo = await makeRepo('no-commit');
  await fs.writeFile(join(repo, 'a.txt'), 'hello\n', 'utf-8');
  const baseline = await commit(repo, 'init');

  const project = await addProject(repo);
  const taskId = newTaskId();
  await tagAt(repo, `oru/baseline-${taskId}`, baseline);

  // task 改了 a.txt 但没 commit
  await fs.writeFile(join(repo, 'a.txt'), 'world\n', 'utf-8');
  // 模拟 endTag 在改完后；实际 git diff baseline..HEAD 在 unstaged 的情况下不工作
  // 所以这里我们 commit 一下作为 endTag 锚点然后再 reset 回 baseline 让它变 unstaged
  // 简单做：直接打 endTag 在 baseline（diff 等于工作树 diff）
  await tagAt(repo, `oru/end-${taskId}`, baseline);

  await createTask(
    makeTask({
      taskId,
      projectId: project.id,
      baselineCommit: baseline,
      endTag: `oru/end-${taskId}`,
      affectedPaths: ['a.txt'],
      commitsCreated: [],
      status: 'done',
    }),
  );

  const r = await rollbackTask(taskId);
  assert(r.ok === true, 'no-commit rollback ok', JSON.stringify(r));
  const after = await fs.readFile(join(repo, 'a.txt'), 'utf-8');
  assert(after === 'hello\n', 'no-commit a.txt restored to "hello"', `got: ${JSON.stringify(after)}`);
}

// ─── 路径 2：已 commit，git revert ─────────────────────────────────────

async function pathAlreadyCommitted(): Promise<void> {
  const repo = await makeRepo('committed');
  await fs.writeFile(join(repo, 'a.txt'), 'hello\n', 'utf-8');
  const baseline = await commit(repo, 'init');
  const project = await addProject(repo);
  const taskId = newTaskId();
  await tagAt(repo, `oru/baseline-${taskId}`, baseline);

  // task 改并 commit
  await fs.writeFile(join(repo, 'a.txt'), 'world\n', 'utf-8');
  const taskCommit = await commit(repo, 'task changes');
  await tagAt(repo, `oru/end-${taskId}`, taskCommit);

  await createTask(
    makeTask({
      taskId,
      projectId: project.id,
      baselineCommit: baseline,
      endTag: `oru/end-${taskId}`,
      affectedPaths: ['a.txt'],
      commitsCreated: [taskCommit],
      status: 'done',
    }),
  );

  const r = await rollbackTask(taskId);
  assert(r.ok === true, 'committed rollback ok', JSON.stringify(r));
  if (r.ok) {
    assert(r.revertedCommits === 1, 'committed: 1 revert commit', `got: ${r.revertedCommits}`);
  }
  const after = await fs.readFile(join(repo, 'a.txt'), 'utf-8');
  assert(after === 'hello\n', 'committed a.txt restored to "hello"', `got: ${JSON.stringify(after)}`);
  // git log 应该有 revert commit
  const g = simpleGit({ baseDir: repo });
  const log = await g.log({ maxCount: 5 });
  const hasRevert = log.all.some((c) => c.message.startsWith('Revert'));
  assert(hasRevert, 'committed has revert commit in history');
}

// ─── 路径 3：用户改别的文件，撤回 task 不动 ─────────────────────────────

async function pathDontTouchUserFiles(): Promise<void> {
  const repo = await makeRepo('user-other');
  await fs.writeFile(join(repo, 'a.txt'), 'a-original\n', 'utf-8');
  await fs.writeFile(join(repo, 'b.txt'), 'b-original\n', 'utf-8');
  const baseline = await commit(repo, 'init');
  const project = await addProject(repo);
  const taskId = newTaskId();
  await tagAt(repo, `oru/baseline-${taskId}`, baseline);

  // task 改了 a.txt 并 commit
  await fs.writeFile(join(repo, 'a.txt'), 'a-task\n', 'utf-8');
  const taskCommit = await commit(repo, 'task: change a');
  await tagAt(repo, `oru/end-${taskId}`, taskCommit);

  // 用户后来改了 b.txt（unstaged）
  await fs.writeFile(join(repo, 'b.txt'), 'b-user\n', 'utf-8');

  await createTask(
    makeTask({
      taskId,
      projectId: project.id,
      baselineCommit: baseline,
      endTag: `oru/end-${taskId}`,
      affectedPaths: ['a.txt'],
      commitsCreated: [taskCommit],
      status: 'done',
    }),
  );

  const r = await rollbackTask(taskId);
  assert(r.ok === true, 'dont-touch rollback ok', JSON.stringify(r));
  const a = await fs.readFile(join(repo, 'a.txt'), 'utf-8');
  const b = await fs.readFile(join(repo, 'b.txt'), 'utf-8');
  assert(a === 'a-original\n', 'a.txt reverted', JSON.stringify(a));
  assert(b === 'b-user\n', 'b.txt NOT touched (user kept)', JSON.stringify(b));
}

// ─── 路径 4：用户改同文件，触发 conflict ──────────────────────────────

async function pathConflict(): Promise<void> {
  const repo = await makeRepo('conflict');
  await fs.writeFile(join(repo, 'a.txt'), 'original\n', 'utf-8');
  const baseline = await commit(repo, 'init');
  const project = await addProject(repo);
  const taskId = newTaskId();
  await tagAt(repo, `oru/baseline-${taskId}`, baseline);

  // task 改 a.txt 并 commit
  await fs.writeFile(join(repo, 'a.txt'), 'task-version\n', 'utf-8');
  const taskCommit = await commit(repo, 'task: change a');
  await tagAt(repo, `oru/end-${taskId}`, taskCommit);

  // 用户后来又改了 a.txt 并 commit（同一文件被覆盖）
  await fs.writeFile(join(repo, 'a.txt'), 'user-override\n', 'utf-8');
  await commit(repo, 'user: override a');

  await createTask(
    makeTask({
      taskId,
      projectId: project.id,
      baselineCommit: baseline,
      endTag: `oru/end-${taskId}`,
      affectedPaths: ['a.txt'],
      commitsCreated: [taskCommit],
      status: 'done',
    }),
  );

  const r = await rollbackTask(taskId);
  assert(
    !r.ok && r.error === 'conflict',
    'conflict detected',
    `got: ${JSON.stringify(r)}`,
  );
  if (!r.ok && r.error === 'conflict') {
    assert(
      r.conflictPaths.includes('a.txt'),
      'conflictPaths contains a.txt',
      JSON.stringify(r.conflictPaths),
    );
  }

  // 然后用户确认强制 rollback（skipConflictCheck）
  // 注意：commit 已被用户后续 commit 覆盖，git revert 必然冲突，这是 git 本质
  // 期望：rollback 模块应自动 git revert --abort 不留脏状态，并返回明确 failed
  const r2 = await rollbackTask(taskId, { skipConflictCheck: true });
  assert(
    r2.ok === false && r2.error === 'failed',
    'conflict force returns clean failed (git revert auto-aborted)',
    JSON.stringify(r2),
  );
  // 验证工作树不在 conflict 状态
  const g = simpleGit({ baseDir: repo });
  const status = await g.status();
  assert(
    !status.conflicted.length,
    'no merge conflict left in working tree',
    `conflicted: ${status.conflicted.join(',')}`,
  );
}

// ─── 路径 5：task 新建文件 → 撤回时删除 ──────────────────────────────

async function pathNewFile(): Promise<void> {
  const repo = await makeRepo('new-file');
  await fs.writeFile(join(repo, 'a.txt'), 'a\n', 'utf-8');
  const baseline = await commit(repo, 'init');
  const project = await addProject(repo);
  const taskId = newTaskId();
  await tagAt(repo, `oru/baseline-${taskId}`, baseline);

  // task 新建 newfile.ts 并 commit
  await fs.writeFile(join(repo, 'newfile.ts'), 'export const x = 1;\n', 'utf-8');
  const taskCommit = await commit(repo, 'task: add newfile');
  await tagAt(repo, `oru/end-${taskId}`, taskCommit);

  await createTask(
    makeTask({
      taskId,
      projectId: project.id,
      baselineCommit: baseline,
      endTag: `oru/end-${taskId}`,
      affectedPaths: ['newfile.ts'],
      commitsCreated: [taskCommit],
      status: 'done',
    }),
  );

  const r = await rollbackTask(taskId);
  assert(r.ok === true, 'new-file rollback ok', JSON.stringify(r));
  // newfile.ts 应该被 revert 删除（git revert 会反向 add）
  // 注意：revert 只是反向 commit；newfile 在 working tree 还在不？
  // git revert 反向应用 commit 内容到工作树 + commit。所以应该删了。
  const fileGone = !existsSync(join(repo, 'newfile.ts'));
  assert(fileGone, 'newfile.ts removed by revert', `existsSync: ${!fileGone}`);
}

// ─── 路径 6：redo rollback ─────────────────────────────────────────────

async function pathRedo(): Promise<void> {
  const repo = await makeRepo('redo');
  await fs.writeFile(join(repo, 'a.txt'), 'hello\n', 'utf-8');
  const baseline = await commit(repo, 'init');
  const project = await addProject(repo);
  const taskId = newTaskId();
  await tagAt(repo, `oru/baseline-${taskId}`, baseline);

  await fs.writeFile(join(repo, 'a.txt'), 'world\n', 'utf-8');
  const taskCommit = await commit(repo, 'task');
  await tagAt(repo, `oru/end-${taskId}`, taskCommit);

  await createTask(
    makeTask({
      taskId,
      projectId: project.id,
      baselineCommit: baseline,
      endTag: `oru/end-${taskId}`,
      affectedPaths: ['a.txt'],
      commitsCreated: [taskCommit],
      status: 'done',
    }),
  );

  const r1 = await rollbackTask(taskId);
  assert(r1.ok === true, 'redo step1 rollback ok');
  const after1 = await fs.readFile(join(repo, 'a.txt'), 'utf-8');
  assert(after1 === 'hello\n', 'redo step1 a.txt = hello', JSON.stringify(after1));

  const r2 = await redoRollback(taskId);
  assert(r2.ok === true, 'redo step2 redoRollback ok', JSON.stringify(r2));
  const after2 = await fs.readFile(join(repo, 'a.txt'), 'utf-8');
  assert(after2 === 'world\n', 'redo step2 a.txt = world', JSON.stringify(after2));
}

// ─── 路径 7：no-baseline 错误 ─────────────────────────────────────────

async function pathNoBaseline(): Promise<void> {
  const repo = await makeRepo('no-baseline');
  await fs.writeFile(join(repo, 'a.txt'), 'hello\n', 'utf-8');
  await commit(repo, 'init');
  const project = await addProject(repo);
  const taskId = newTaskId();
  // 故意不打 tag，task.baselineCommit 也设 null
  await createTask(
    makeTask({
      taskId,
      projectId: project.id,
      baselineCommit: '',
      endTag: null,
      affectedPaths: ['a.txt'],
      commitsCreated: [],
      status: 'done',
    }),
  );
  const r = await rollbackTask(taskId);
  assert(!r.ok && r.error === 'no-baseline', 'no-baseline returns no-baseline error', JSON.stringify(r));
}

// ─── 路径 8（L4）：多 commit 倒序 revert 中途冲突 → 部分回滚被清理回起点 ──────
async function pathPartialRevertConflictCleanup(): Promise<void> {
  const repo = await makeRepo('partial');
  // 两行互不相干，便于让"第一个 revert 干净、第二个 revert 冲突"
  await fs.writeFile(join(repo, 'a.txt'), 'X\nY\n', 'utf-8');
  const baseline = await commit(repo, 'init');
  const project = await addProject(repo);
  const taskId = newTaskId();
  await tagAt(repo, `oru/baseline-${taskId}`, baseline);

  // task commit A：改第 2 行 Y→A
  await fs.writeFile(join(repo, 'a.txt'), 'X\nA\n', 'utf-8');
  const cA = await commit(repo, 'task A: line2');
  // task commit B：改第 1 行 X→B
  await fs.writeFile(join(repo, 'a.txt'), 'B\nA\n', 'utf-8');
  const cB = await commit(repo, 'task B: line1');
  await tagAt(repo, `oru/end-${taskId}`, cB);

  // 用户在 task 之后又改第 2 行 A→C 并 commit（HEAD=C）
  await fs.writeFile(join(repo, 'a.txt'), 'B\nC\n', 'utf-8');
  const cUser = await commit(repo, 'user: line2 again');

  await createTask(
    makeTask({
      taskId,
      projectId: project.id,
      baselineCommit: baseline,
      endTag: `oru/end-${taskId}`,
      affectedPaths: ['a.txt'],
      commitsCreated: [cA, cB],
      status: 'done',
    }),
  );

  // 倒序 revert：先 revert B（第 1 行，干净落一个 revert commit）→ 再 revert A（第 2 行，
  // 与用户改冲突）。skipConflictCheck 跳过前置冲突检查，逼出 revert 循环内冲突。
  const r = await rollbackTask(taskId, { skipConflictCheck: true });
  assert(!r.ok && r.error === 'failed', 'L4: 中途冲突返回 failed', JSON.stringify(r));

  const g = simpleGit({ baseDir: repo });
  // 清理后 HEAD 应回到用户 commit（已落的 B-revert 被 reset 掉，无残留 Revert commit）
  const head = (await g.revparse(['HEAD'])).trim();
  assert(head === cUser, 'L4: HEAD reset 回 preRollbackTag（用户 commit），无残留 revert', `head=${head.slice(0, 7)} cUser=${cUser.slice(0, 7)}`);
  const after = await fs.readFile(join(repo, 'a.txt'), 'utf-8');
  assert(after === 'B\nC\n', 'L4: 工作树回到 rollback 前状态（B\\nC），非部分回滚', JSON.stringify(after));
  const log = await g.log({ maxCount: 5 });
  assert(!log.all.some((c) => c.message.startsWith('Revert')), 'L4: 历史里没有残留 Revert commit');
}

async function main() {
  console.log('=== rollback smoke ===');
  try {
    await pathNoCommit();
    await pathAlreadyCommitted();
    await pathDontTouchUserFiles();
    await pathConflict();
    await pathNewFile();
    await pathRedo();
    await pathNoBaseline();
    await pathPartialRevertConflictCleanup();
  } catch (e) {
    console.error('[smoke] unexpected error:', e);
    process.exit(1);
  }
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
