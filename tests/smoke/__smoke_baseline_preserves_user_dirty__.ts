/**
 * Baseline 不破坏用户外部改动 smoke
 *
 * 复现 spec docs/superpowers/specs/2026-05-02-baseline-stash-rollback-fix.md 的核心保证：
 * 1. recordBaseline 不再 stash —— 工作区里"task 启动前已存在的 dirty 改动"原样保留
 * 2. computeAffectedPaths 排除"用户预先改且 task 没动过"的文件
 *    场景：用户改 a.txt（task 启动前）+ task 改 b.txt → affectedPaths = ['b.txt']
 * 3. computeAffectedPaths 把"用户和 task 都动了"的文件标进 mixedDirtyPaths（不进 affectedPaths）
 *    场景：用户改 a.txt（task 启动前）+ task 又改 a.txt → affectedPaths 不含 a，mixedDirtyPaths 含 a
 *
 * 不打 Claude，纯 git + fs 验证
 */
import './__smoke_isolate__'; // 必须第一行：ORU_DIR 重定向到 tmpdir
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { recordBaseline, computeAffectedPaths } from '../../electron/main/tasks/git';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function makeRepo(prefix: string): Promise<string> {
  const path = join(tmpdir(), `oru-bp-${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  await fs.mkdir(path, { recursive: true });
  const g = simpleGit({ baseDir: path });
  await g.init();
  await g.addConfig('user.email', 'test@oru.local', false, 'local');
  await g.addConfig('user.name', 'oru-test', false, 'local');
  await g.addConfig('commit.gpgsign', 'false', false, 'local');
  return path;
}

async function commit(repo: string, msg: string): Promise<string> {
  const g = simpleGit({ baseDir: repo });
  await g.add('.');
  await g.commit(msg);
  return (await g.revparse(['HEAD'])).trim();
}

// ─── 场景 1：recordBaseline 不 stash 用户预先改动 ────────────────────────

async function scenarioPreserveUserDirty(): Promise<void> {
  const repo = await makeRepo('preserve');
  await fs.writeFile(join(repo, 'a.txt'), 'committed-a\n', 'utf-8');
  await fs.writeFile(join(repo, 'b.txt'), 'committed-b\n', 'utf-8');
  await commit(repo, 'init');

  // 用户在 task 启动前改了 a.txt（unstaged）+ 新建 untracked.txt
  await fs.writeFile(join(repo, 'a.txt'), 'user-modified-a\n', 'utf-8');
  await fs.writeFile(join(repo, 'untracked.txt'), 'user-new\n', 'utf-8');

  const baseline = await recordBaseline(repo, 'task-preserve');

  assert(baseline.kind === 'commit', '场景1: baseline kind=commit', JSON.stringify(baseline));

  // 工作区改动应该完整保留（不被 stash）
  const aAfter = await fs.readFile(join(repo, 'a.txt'), 'utf-8');
  assert(aAfter === 'user-modified-a\n', '场景1: a.txt 改动保留', `got: ${JSON.stringify(aAfter)}`);

  const untrackedExists = await fs
    .access(join(repo, 'untracked.txt'))
    .then(() => true)
    .catch(() => false);
  assert(untrackedExists, '场景1: untracked.txt 仍在工作区', `exists: ${untrackedExists}`);

  // git stash list 应该没有任何 oru-baseline-* 条目
  const g = simpleGit({ baseDir: repo });
  const stashOut = await g.raw(['stash', 'list']).catch(() => '');
  const hasBaselineStash = stashOut.includes('oru-baseline-');
  assert(!hasBaselineStash, '场景1: 没有 oru-baseline-* stash 被创建', `stash list: ${stashOut.trim()}`);

  // baseline 应该捕获了 preExistingPaths，含 a.txt 和 untracked.txt 的 hash
  if (baseline.kind === 'commit') {
    const pre = baseline.preExistingPaths;
    assert(
      typeof pre === 'object' && pre !== null && 'a.txt' in pre,
      '场景1: preExistingPaths 含 a.txt',
      JSON.stringify(pre),
    );
    assert(
      'untracked.txt' in (pre ?? {}),
      '场景1: preExistingPaths 含 untracked.txt',
      JSON.stringify(pre),
    );
    assert(
      typeof pre['a.txt'] === 'string' && pre['a.txt'].length === 40,
      '场景1: preExistingPaths.a.txt 是 40 位 sha',
      pre['a.txt'],
    );
  }
}

// ─── 场景 2：用户改 a + task 改 b → affectedPaths 只有 b ──────────────

async function scenarioExcludeUntouched(): Promise<void> {
  const repo = await makeRepo('exclude');
  await fs.writeFile(join(repo, 'a.txt'), 'committed-a\n', 'utf-8');
  await fs.writeFile(join(repo, 'b.txt'), 'committed-b\n', 'utf-8');
  await commit(repo, 'init');

  // 用户在 task 启动前改了 a.txt
  await fs.writeFile(join(repo, 'a.txt'), 'user-modified-a\n', 'utf-8');

  const baseline = await recordBaseline(repo, 'task-exclude');
  if (baseline.kind !== 'commit') {
    assert(false, '场景2: baseline 必须是 commit kind');
    return;
  }

  // task 模拟改了 b.txt（不动 a）
  await fs.writeFile(join(repo, 'b.txt'), 'task-modified-b\n', 'utf-8');

  const result = await computeAffectedPaths(repo, baseline.tag ?? baseline.commit, baseline.preExistingPaths);

  assert(
    result.affectedPaths.length === 1 && result.affectedPaths[0] === 'b.txt',
    '场景2: affectedPaths 只含 b.txt',
    JSON.stringify(result.affectedPaths),
  );
  assert(
    result.mixedDirtyPaths.length === 0,
    '场景2: mixedDirtyPaths 为空（a 未被 task 动）',
    JSON.stringify(result.mixedDirtyPaths),
  );
}

// ─── 场景 3：用户改 a + task 也改 a → affectedPaths 不含 a，mixedDirty 含 a ─

async function scenarioMixedDirty(): Promise<void> {
  const repo = await makeRepo('mixed');
  await fs.writeFile(join(repo, 'a.txt'), 'committed-a\n', 'utf-8');
  await commit(repo, 'init');

  // 用户改 a.txt（task 启动前）
  await fs.writeFile(join(repo, 'a.txt'), 'user-modified-a\n', 'utf-8');

  const baseline = await recordBaseline(repo, 'task-mixed');
  if (baseline.kind !== 'commit') {
    assert(false, '场景3: baseline 必须是 commit kind');
    return;
  }

  // task 又改了 a.txt（在用户改的基础上叠加）
  await fs.writeFile(join(repo, 'a.txt'), 'task-overwrote-a\n', 'utf-8');

  const result = await computeAffectedPaths(repo, baseline.tag ?? baseline.commit, baseline.preExistingPaths);

  assert(
    !result.affectedPaths.includes('a.txt'),
    '场景3: affectedPaths 不含 a.txt（避免 rollback 误撤用户改动）',
    JSON.stringify(result.affectedPaths),
  );
  assert(
    result.mixedDirtyPaths.includes('a.txt'),
    '场景3: mixedDirtyPaths 含 a.txt',
    JSON.stringify(result.mixedDirtyPaths),
  );
}

// ─── 场景 4：纯 task 改动（baseline 时工作区干净）→ 行为不变 ────────────

async function scenarioCleanBaseline(): Promise<void> {
  const repo = await makeRepo('clean');
  await fs.writeFile(join(repo, 'a.txt'), 'committed-a\n', 'utf-8');
  await commit(repo, 'init');

  // baseline 时工作区干净
  const baseline = await recordBaseline(repo, 'task-clean');
  if (baseline.kind !== 'commit') {
    assert(false, '场景4: baseline 必须是 commit kind');
    return;
  }
  assert(
    Object.keys(baseline.preExistingPaths).length === 0,
    '场景4: 干净工作区 → preExistingPaths 为空',
    JSON.stringify(baseline.preExistingPaths),
  );

  // task 改了 a.txt
  await fs.writeFile(join(repo, 'a.txt'), 'task-a\n', 'utf-8');

  const result = await computeAffectedPaths(repo, baseline.tag ?? baseline.commit, baseline.preExistingPaths);
  assert(
    result.affectedPaths.length === 1 && result.affectedPaths[0] === 'a.txt',
    '场景4: 干净 baseline → affectedPaths = [a.txt]',
    JSON.stringify(result.affectedPaths),
  );
  assert(
    result.mixedDirtyPaths.length === 0,
    '场景4: 干净 baseline → mixedDirtyPaths 为空',
    JSON.stringify(result.mixedDirtyPaths),
  );
}

// ─── 场景 5（L1）：用户预改 a + task 删除 a → affected 含 a（可回滚），不进 mixed ─
// 旧实现：hash-object 抛错→currentSha=''→误判进 mixed→rollback 跳过→文件静默丢失
async function scenarioUserDirtyThenTaskDeletes(): Promise<void> {
  const repo = await makeRepo('del');
  await fs.writeFile(join(repo, 'a.txt'), 'committed-a\n', 'utf-8');
  await commit(repo, 'init');

  // 用户在 task 启动前改了 a.txt
  await fs.writeFile(join(repo, 'a.txt'), 'user-modified-a\n', 'utf-8');

  const baseline = await recordBaseline(repo, 'task-del');
  if (baseline.kind !== 'commit') {
    assert(false, '场景5: baseline 必须是 commit kind');
    return;
  }

  // task 删除了 a.txt
  await fs.rm(join(repo, 'a.txt'));

  const result = await computeAffectedPaths(repo, baseline.tag ?? baseline.commit, baseline.preExistingPaths);
  assert(
    result.affectedPaths.includes('a.txt'),
    '场景5(L1): 被 task 删除的预改文件进 affectedPaths（可回滚恢复）',
    JSON.stringify(result.affectedPaths),
  );
  assert(
    !result.mixedDirtyPaths.includes('a.txt'),
    '场景5(L1): 不再误判进 mixedDirtyPaths',
    JSON.stringify(result.mixedDirtyPaths),
  );
}

async function main(): Promise<void> {
  console.log('=== baseline-preserves-user-dirty smoke ===');
  try {
    await scenarioPreserveUserDirty();
    await scenarioExcludeUntouched();
    await scenarioMixedDirty();
    await scenarioCleanBaseline();
    await scenarioUserDirtyThenTaskDeletes();
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
