/**
 * 非 git 项目「提案守卫 → 提示」smoke
 *
 * 守卫从「拦截」改为「提示」后，validateProposeTarget 只回答「目标是不是 git 仓」这一个事实
 * （不再有 'required'/'skipped' 三态），rollbackable 的强制与提示触发各自解耦。
 *
 * 验证：
 * 1. recordBaseline / computeAffectedPaths 对非 git 项目仍优雅处理（不变）
 * 2. validateProposeTarget 返回简化后的 ProposeValidation：
 *    - target=null        → ok + isGit:true（家目录任务不强制 rollbackable）
 *    - target=git 项目    → ok + isGit:true
 *    - target=非 git 项目 → ok + isGit:false
 *    - target=不存在 id   → !ok + reason
 *
 * 不打 Claude
 */
import './__smoke_isolate__'; // 必须第一行：ORU_DIR 重定向到 tmpdir，避免污染真实 ~/.oru
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { addProject, removeProject } from '../../electron/main/projects/store';
import { recordBaseline, computeAffectedPaths } from '../../electron/main/tasks/git';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function makeNoGitDir(): Promise<string> {
  const path = join(tmpdir(), `oru-nogit-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(path, 'a.txt'), 'hello\n', 'utf-8');
  // 故意不 git init
  return path;
}

async function makeGitDir(): Promise<string> {
  const path = join(tmpdir(), `oru-git-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(path, 'a.txt'), 'hello\n', 'utf-8');
  const g = simpleGit({ baseDir: path });
  await g.init();
  await g.addConfig('user.email', 'test@oru.local', false, 'local');
  await g.addConfig('user.name', 'oru-test', false, 'local');
  await g.addConfig('commit.gpgsign', 'false', false, 'local');
  await g.add('.');
  await g.commit('init');
  return path;
}

async function main(): Promise<void> {
  console.log('=== nogit smoke ===');

  // ─── recordBaseline 对非 git 项目应返回 no-repo ───
  const noGit = await makeNoGitDir();
  const baseline = await recordBaseline(noGit, 'fake-task-id');
  assert(baseline.kind === 'no-repo', 'recordBaseline(非 git) 返回 no-repo', JSON.stringify(baseline));

  // ─── computeAffectedPaths 对非 git 项目应返回空 ───
  const result = await computeAffectedPaths(noGit, 'baseline-ref');
  assert(
    result.affectedPaths.length === 0 && result.mixedDirtyPaths.length === 0,
    'computeAffectedPaths(非 git) 返回空 affected + 空 mixedDirty',
    JSON.stringify(result),
  );

  // ─── 对照组：git 项目 recordBaseline 正常 ───
  const gitDir = await makeGitDir();
  const baseline2 = await recordBaseline(gitDir, 'real-task-id');
  assert(baseline2.kind === 'commit', 'recordBaseline(git 项目) 返回 commit kind', JSON.stringify(baseline2));
  assert(
    baseline2.kind === 'commit' && typeof baseline2.tag === 'string' && baseline2.tag.startsWith('oru/baseline-'),
    'recordBaseline 在 git 项目里同时打 oru/baseline-<id> tag',
    baseline2.kind === 'commit' ? baseline2.tag ?? 'null' : 'wrong kind',
  );

  // ─── propose_action validation：新版 ProposeValidation 接口 ───
  const nonGitProject = await addProject(noGit);
  const gitProject = await addProject(gitDir);

  const { validateProposeTarget } = await import('../../electron/main/agent/oruMcpFactory');

  // case 1: target=null（家目录任务）→ ok + isGit:true
  const r1 = await validateProposeTarget(null);
  assert(r1.ok && r1.isGit === true, '家目录任务 (null) → ok + isGit:true', JSON.stringify(r1));

  // case 2: 不存在的 project_id → 硬拒
  const r2 = await validateProposeTarget('prj_nonexistent_xyz');
  assert(!r2.ok, '不存在的 project_id → !ok', JSON.stringify(r2));
  assert(
    !r2.ok && (r2.reason.includes('找不到') || r2.reason.includes('not found') || r2.reason.includes('PROJECT')),
    '硬拒原因提示找不到',
    !r2.ok ? r2.reason.slice(0, 80) : 'wrong shape',
  );

  // case 3: git 项目 → ok + isGit:true
  const r3 = await validateProposeTarget(gitProject.id);
  assert(r3.ok && r3.isGit === true, 'git 项目 → ok + isGit:true', JSON.stringify(r3));

  // case 4: 非 git 项目 → ok + isGit:false
  const r4 = await validateProposeTarget(nonGitProject.id);
  assert(r4.ok && r4.isGit === false, '非 git 项目 → ok + isGit:false', JSON.stringify(r4));

  // ─── 清理 ───
  try {
    await removeProject(nonGitProject.id);
  } catch {}
  try {
    await removeProject(gitProject.id);
  } catch {}
  try {
    await fs.rm(noGit, { recursive: true, force: true });
  } catch {}
  try {
    await fs.rm(gitDir, { recursive: true, force: true });
  } catch {}

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
