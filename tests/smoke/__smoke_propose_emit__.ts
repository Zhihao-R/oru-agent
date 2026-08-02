/**
 * propose_action 提案构造 smoke
 *
 * 守卫从「拦截」改为「提示」后，proposal 不再携带 gitGuard 字段；rollbackable 仍按
 * 「项目是不是 git 仓」强制——非 git 一律 false（卡片底部据此标注「不可自动回滚」）。
 *
 * 验证 buildProposalFromInput 的核心映射：
 * 1. git 项目：rollbackable 尊重 Twin 输入；proposal 无 gitGuard 字段
 * 2. 非 git 项目：rollbackable 被强制为 false（即使 Twin 填 true）
 * 3. 不存在的 project_id：!ok，工具文案含"提案被拒绝"
 * 4. target=null（家目录）：rollbackable 尊重 Twin 输入
 *
 * 不打 Claude
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import { addProject, removeProject } from '../../electron/main/projects/store';
import { buildProposalFromInput, type ProposeBuildInput } from '../../electron/main/agent/oruMcpFactory';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

async function makeNoGitDir(): Promise<string> {
  const path = join(tmpdir(), `oru-pe-nogit-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  await fs.mkdir(path, { recursive: true });
  await fs.writeFile(join(path, 'a.txt'), 'hello\n', 'utf-8');
  return path;
}

async function makeGitDir(): Promise<string> {
  const path = join(tmpdir(), `oru-pe-git-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
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

function baseInput(overrides: Partial<ProposeBuildInput> = {}): ProposeBuildInput {
  return {
    conversationId: 'cnv_test',
    title: '测试提案',
    description: '测试用',
    targetProjectId: null,
    risk: 'low',
    rollbackable: true,
    rawPlan: 'do something',
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log('=== propose_emit smoke ===');

  const noGit = await makeNoGitDir();
  const gitDir = await makeGitDir();
  const nonGitProject = await addProject(noGit);
  const gitProject = await addProject(gitDir);

  // case 1: git 项目 + Twin 填 rollbackable=true → rollbackable=true；无 gitGuard 字段
  const r1 = await buildProposalFromInput(baseInput({ targetProjectId: gitProject.id, rollbackable: true }));
  assert(r1.ok, 'git 项目 → ok', JSON.stringify(r1));
  if (r1.ok) {
    assert(r1.proposal.rollbackable === true, 'git 项目 → 尊重 Twin 输入的 rollbackable=true', String(r1.proposal.rollbackable));
    assert(!('gitGuard' in r1.proposal), 'proposal 不再携带 gitGuard 字段', JSON.stringify(Object.keys(r1.proposal)));
  }

  // case 2: 非 git 项目 + Twin 填 rollbackable=true → rollbackable 被强制 false
  const r2 = await buildProposalFromInput(baseInput({ targetProjectId: nonGitProject.id, rollbackable: true }));
  assert(r2.ok, '非 git 项目 → ok（不拦截）', JSON.stringify(r2));
  if (r2.ok) {
    assert(
      r2.proposal.rollbackable === false,
      '非 git 项目 → rollbackable 被强制 false（即使 Twin 填 true）',
      String(r2.proposal.rollbackable),
    );
  }

  // case 3: 不存在的 project_id → !ok，文案含"提案被拒绝"
  const r3 = await buildProposalFromInput(baseInput({ targetProjectId: 'prj_ghost_xxx' }));
  assert(!r3.ok, '不存在的 project_id → !ok', JSON.stringify(r3));
  assert(
    r3.toolText.startsWith('提案被拒绝'),
    '硬拒文案以"提案被拒绝"开头',
    r3.toolText.slice(0, 80),
  );

  // case 4: target=null（家目录任务）→ rollbackable 尊重 Twin 输入
  const r4 = await buildProposalFromInput(baseInput({ targetProjectId: null, rollbackable: true }));
  assert(r4.ok, '家目录任务 (null) → ok', JSON.stringify(r4));
  if (r4.ok) {
    assert(r4.proposal.rollbackable === true, 'null target → 尊重 Twin 输入的 rollbackable=true', String(r4.proposal.rollbackable));
  }

  // ─── 清理 ───
  try { await removeProject(nonGitProject.id); } catch {}
  try { await removeProject(gitProject.id); } catch {}
  try { await fs.rm(noGit, { recursive: true, force: true }); } catch {}
  try { await fs.rm(gitDir, { recursive: true, force: true }); } catch {}

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
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
