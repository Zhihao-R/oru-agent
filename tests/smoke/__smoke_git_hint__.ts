/**
 * 「项目未版本管理提示」smoke
 *
 * 验证从「拦截」改为「提示」后的核心行为（tech doc 2026-06-15「测试」章节）：
 *
 * 提示触发与覆盖（三类写操作的项目归属各走一条解析路径，都汇到 maybeShowGitHint）：
 *   - code 路径：按 targetProjectId → getProject
 *   - file.write 路径：按 proposal.path → findProjectByPath（前缀归属，含边界）
 *   - bash 路径：按 ctx.activeProjectId → getProject
 *   首个写操作 → onGitHint 触发一次；同项目同日第二次（任意类型）→ 不再触发。
 *   并发两个写操作打到同一非 git 项目 → 仅一次（markGitHintShown 锁内判定去重）。
 *   git 项目 / 家目录任务（project 为 null）→ 零触发。
 *
 * 时效边界：gitHintShownUntil 昨日末刻（已过期）→ isGitHintShownNow 为 false（可重新提示）。
 * 数据兼容：仅有旧 gitGuardSkippedUntil 的 Project rehydrate 后 isGitHintShownNow 正确接管。
 *
 * 不打 Claude
 */
import './__smoke_isolate__'; // 必须第一行：ORU_DIR 重定向到 tmpdir
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';
import type { Project } from '@shared/types';
import {
  addProject,
  removeProject,
  getProject,
  findProjectByPath,
  isGitRepo,
  isGitHintShownNow,
  markGitHintShown,
  __clearCacheForTest,
} from '../../electron/main/projects/store';
import { maybeShowGitHint } from '../../electron/main/projects/gitHint';
import { configPath } from '../../electron/main/runtime/paths';
import { getCurrentOwnerId } from '../../electron/main/identity/getCurrentOwnerId';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

// 提示与项目无关、回调无参，故只数次数；归属正确由「每个 ctx 解析自己的项目」保证（见各用例）
type HintCounter = { n: number };
function makeCtx(counter: HintCounter, activeProjectId?: string): ToolContext {
  return makeToolContext({
    conversationId: 'cnv_githint',
    agentId: 'agt_test',
    ownerId: 'local-user',
    activeProjectId,
    onProposal: undefined, // 原工厂无 onProposal——git hint 路径不经审批，保持背景语义
    onGitHint: async () => {
      counter.n += 1;
    },
  });
}

async function makeNoGitDir(tag: string): Promise<string> {
  const path = join(tmpdir(), `oru-hint-${tag}-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
  await fs.mkdir(join(path, 'sub'), { recursive: true });
  await fs.writeFile(join(path, 'a.txt'), 'hello\n', 'utf-8');
  return path;
}

async function makeGitDir(tag: string): Promise<string> {
  const path = await makeNoGitDir(tag);
  const g = simpleGit({ baseDir: path });
  await g.init();
  await g.addConfig('user.email', 'test@oru.local', false, 'local');
  await g.addConfig('user.name', 'oru-test', false, 'local');
  await g.add('.');
  await g.commit('init');
  return path;
}

function endOfToday(offsetDays = 0): number {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

async function main(): Promise<void> {
  console.log('=== git_hint smoke ===');

  const dirA = await makeNoGitDir('A');
  const dirB = await makeNoGitDir('B');
  const dirC = await makeNoGitDir('C');
  const dirGit = await makeGitDir('git');
  const projA = await addProject(dirA);
  const projB = await addProject(dirB);
  const projC = await addProject(dirC);
  const projGit = await addProject(dirGit);

  // ─── isGitRepo：git 判定单一来源 ───
  assert(isGitRepo(dirGit) === true, 'isGitRepo(git 仓) === true');
  assert(isGitRepo(dirA) === false, 'isGitRepo(非 git) === false');

  // ─── 触发点 1：code 路径，按 targetProjectId → getProject ───
  const cA: HintCounter = { n: 0 };
  const ctxCode = makeCtx(cA);
  await maybeShowGitHint(ctxCode, await getProject(projA.id));
  assert(cA.n === 1, 'code 路径：非 git 项目首次写 → onGitHint 一次', JSON.stringify(cA));

  // ─── 同项目同日第二次（file.write 路径，按 path → findProjectByPath）→ 不再触发 ───
  const resolvedByPath = await findProjectByPath(join(dirA, 'sub', 'x.txt'));
  assert(resolvedByPath?.id === projA.id, 'findProjectByPath：项目内文件路径前缀归属正确', resolvedByPath?.id);
  await maybeShowGitHint(ctxCode, resolvedByPath);
  assert(cA.n === 1, '同项目同日第二次写（file.write）→ onGitHint 不再触发（每项目每天一次）', String(cA.n));

  // ─── findProjectByPath 前缀边界：兄弟目录 /dirA + 'X' 不应误中 ───
  const sibling = await findProjectByPath(`${dirA}-sibling/a.txt`);
  assert(sibling === null, 'findProjectByPath：兄弟前缀目录（dirA-sibling）不误中 dirA', sibling ? sibling.id : 'null');

  // ─── 触发点 2：bash 路径，按 ctx.activeProjectId → getProject（独立非 git 项目，独立提示一次）───
  const cB: HintCounter = { n: 0 };
  const ctxBash = makeCtx(cB, projB.id);
  const bashProject = ctxBash.activeProjectId ? await getProject(ctxBash.activeProjectId) : null;
  await maybeShowGitHint(ctxBash, bashProject);
  assert(cB.n === 1, 'bash 路径：另一非 git 项目独立提示一次', JSON.stringify(cB));

  // ─── git 项目 → 零触发 ───
  const cGit: HintCounter = { n: 0 };
  await maybeShowGitHint(makeCtx(cGit), await getProject(projGit.id));
  assert(cGit.n === 0, 'git 项目 → onGitHint 零触发', String(cGit.n));

  // ─── 家目录任务（project 为 null）→ 零触发 ───
  const cNull: HintCounter = { n: 0 };
  await maybeShowGitHint(makeCtx(cNull), null);
  assert(cNull.n === 0, '家目录任务（project=null）→ onGitHint 零触发', String(cNull.n));

  // ─── 并发去重：两个写操作同时打同一非 git 项目 → 仅一次（markGitHintShown 锁内判定）───
  const cC: HintCounter = { n: 0 };
  const ctxC = makeCtx(cC);
  const pC = await getProject(projC.id);
  await Promise.all([maybeShowGitHint(ctxC, pC), maybeShowGitHint(ctxC, pC)]);
  assert(cC.n === 1, '并发两写同一非 git 项目 → onGitHint 仅一次（锁内去重）', String(cC.n));

  // ─── markGitHintShown 原语：首次翻转 true，再次 false ───
  const dirD = await makeNoGitDir('D');
  const projD = await addProject(dirD);
  const first = await markGitHintShown(projD.id);
  const second = await markGitHintShown(projD.id);
  assert(first === true && second === false, 'markGitHintShown：首次 true、再次 false（当日去重）', `${first}/${second}`);

  // ─── 时效边界：gitHintShownUntil 已过期（昨日末刻）→ isGitHintShownNow false ───
  const expiredProject = { gitHintShownUntil: endOfToday(-1) } as Project;
  const validProject = { gitHintShownUntil: endOfToday(0) } as Project;
  assert(isGitHintShownNow(expiredProject) === false, '时效：昨日末刻已过期 → isGitHintShownNow false');
  assert(isGitHintShownNow(validProject) === true, '时效：今日末刻未过期 → isGitHintShownNow true');

  // ─── 数据兼容：仅有旧 gitGuardSkippedUntil 的 Project rehydrate 后正确接管 ───
  const legacyDir = await makeNoGitDir('legacy');
  const owner = getCurrentOwnerId();
  const cfgPath = configPath(owner);
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
  cfg.projects.push({
    id: 'prj_legacy_compat',
    path: legacyDir,
    name: 'legacy',
    addedAt: Date.now(),
    lastOpenedAt: Date.now(),
    hasClaudeMd: false,
    gitGuardSkippedUntil: endOfToday(0), // 仅旧字段，无 gitHintShownUntil
  });
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
  __clearCacheForTest();
  const legacyProject = await getProject('prj_legacy_compat');
  assert(
    legacyProject.gitHintShownUntil === endOfToday(0),
    '数据兼容：rehydrate 把旧 gitGuardSkippedUntil 接管为 gitHintShownUntil',
    String(legacyProject.gitHintShownUntil),
  );
  assert(
    isGitHintShownNow(legacyProject) === true,
    '数据兼容：旧值接管后 isGitHintShownNow 当日为 true（不重复提示）',
  );
  assert((await markGitHintShown('prj_legacy_compat')) === false, '数据兼容：当日 markGitHintShown 返回 false（已视为提示过）');

  // ─── 清理 ───
  for (const p of [projA, projB, projC, projD, projGit]) {
    try { await removeProject(p.id); } catch {}
  }
  try { await removeProject('prj_legacy_compat'); } catch {}
  for (const d of [dirA, dirB, dirC, dirD, dirGit, legacyDir]) {
    try { await fs.rm(d, { recursive: true, force: true }); } catch {}
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
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
