/**
 * 派工前后 git 状态管理：baseline + affectedPaths 计算
 *
 * 派工前 recordBaseline：
 * - 不再 stash 用户工作区改动（关键：保护用户在 oru 之外做的修改）
 * - 拍一份"启动时已存在的 dirty files snapshot"（path → blob sha）
 *   用于 task 完成时把"用户预先改、task 没动"的文件从 affectedPaths 排除
 * - 记录当前 HEAD commit 作为 baseline
 * - 立即打 git tag oru/baseline-<taskId>，跨重启可恢复
 *
 * Rollback 走 ../git/rollback.ts 的精确反向 patch / revert，本文件不再提供 hard reset 路径
 *
 * 设计文档：docs/superpowers/specs/2026-05-02-baseline-stash-rollback-fix.md
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

export type Baseline =
  | { kind: 'no-repo' }
  | {
      kind: 'commit';
      commit: string;
      tag: string | null;
      /**
       * 启动时已存在的 dirty 文件 → 工作树当前内容的 blob sha
       * 用于在 computeAffectedPaths 排除"用户预先改、task 没动"的文件。
       * 仅内存流转，不持久化到 task store。
       */
      preExistingPaths: Record<string, string>;
    };

export type AffectedPathsResult = {
  /** task 应该被 rollback 撤回的文件集合（已排除用户预先改且 task 未动的文件） */
  affectedPaths: string[];
  /** 用户预先已改、task 又改过 → rollback 应跳过、UI 应 warn 的文件 */
  mixedDirtyPaths: string[];
};

/**
 * 单个变更文件的归类判定（承重：误判会让用户活编辑被 rollback 静默丢失）。纯函数抽出便于
 * 穷举所有分支——computeAffectedPaths 循环仍原样取 IO（当前 hash / 文件是否存在），只把判定委托到这里。
 * - `preSha === undefined`：task 启动前不在 dirty 列表 → 全是 task 动的 → 'affected'
 * - 文件已被删（无 currentSha 且不存在）：用户预改非空（曾有内容）→ 'affected'（可安全回滚）；
 *   预改为空串（用户预改本身就是删）→ task 没实质改动 → 'excluded'
 * - currentSha 与 preSha 相同：用户改过、task 没动 → 'excluded'
 * - 否则：用户改过、task 也动了 → 'mixed'（保护用户活编辑，rollback 跳过）
 */
export function classifyOnePath(args: {
  preSha: string | undefined;
  currentSha: string;
  fileExists: boolean;
}): 'affected' | 'mixed' | 'excluded' {
  const { preSha, currentSha, fileExists } = args;
  if (preSha === undefined) return 'affected';
  if (!currentSha && !fileExists) return preSha ? 'affected' : 'excluded';
  if (currentSha && currentSha === preSha) return 'excluded';
  return 'mixed';
}

export async function recordBaseline(projectPath: string, taskId?: string): Promise<Baseline> {
  if (!existsSync(join(projectPath, '.git'))) {
    return { kind: 'no-repo' };
  }
  const g = simpleGit({ baseDir: projectPath });
  try {
    // 拍 preExisting 快照：对每个 dirty file 算工作树当前内容的 blob sha
    const status = await g.status();
    const preExistingPaths: Record<string, string> = {};
    for (const f of status.files) {
      const p = f.path;
      try {
        const sha = (await g.raw(['hash-object', '--', p])).trim();
        preExistingPaths[p] = sha;
      } catch {
        // 文件可能已被删除等异常情况；用空串占位（hash 比对一定不匹配 → 视为已变化）
        preExistingPaths[p] = '';
      }
    }

    const head = (await g.revparse(['HEAD'])).trim();
    let tag: string | null = null;
    if (taskId) {
      tag = `oru/baseline-${taskId}`;
      try {
        await g.tag([tag, head]);
      } catch {
        // 重复 tag 等失败不阻断 baseline 记录
        tag = null;
      }
    }
    return { kind: 'commit', commit: head, tag, preExistingPaths };
  } catch (e) {
    throw new Error(`baseline failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 任务完成时打 oru/end-<taskId> tag；返回 tag 名或 null */
export async function recordEndTag(projectPath: string, taskId: string): Promise<string | null> {
  if (!existsSync(join(projectPath, '.git'))) return null;
  const g = simpleGit({ baseDir: projectPath });
  const tag = `oru/end-${taskId}`;
  try {
    const head = (await g.revparse(['HEAD'])).trim();
    await g.tag([tag, head]);
    return tag;
  } catch {
    return null;
  }
}

/**
 * 计算 task 改动过的文件列表（相对 baselineRef）+ mixedDirty 集合
 *
 * - 全集 = git diff baselineRef + untracked（同原逻辑）
 * - 对每个属于 preExistingPaths 的 path：
 *   - 若工作树当前 hash == preExisting hash → 用户预先改、task 没动 → 排除
 *   - 否则 → 既有用户改动又有 task 改动 → 入 mixedDirtyPaths（不入 affectedPaths）
 */
export async function computeAffectedPaths(
  projectPath: string,
  baselineRef: string,
  preExistingPaths: Record<string, string> = {},
): Promise<AffectedPathsResult> {
  if (!existsSync(join(projectPath, '.git'))) {
    return { affectedPaths: [], mixedDirtyPaths: [] };
  }
  const g = simpleGit({ baseDir: projectPath });
  const all = new Set<string>();
  try {
    const diffOut = await g.diff(['--name-only', baselineRef]);
    for (const s of diffOut.split('\n')) {
      const t = s.trim();
      if (t) all.add(t);
    }
  } catch {
    // 忽略
  }
  try {
    const untrackedOut = await g.raw(['ls-files', '--others', '--exclude-standard']);
    for (const s of untrackedOut.split('\n')) {
      const t = s.trim();
      if (t) all.add(t);
    }
  } catch {
    // 忽略
  }

  const affected: string[] = [];
  const mixed: string[] = [];
  for (const p of all) {
    if (!(p in preExistingPaths)) {
      // task 启动前不在 dirty 列表 → 全是 task 动的（快路径：不必算 hash）
      affected.push(p);
      continue;
    }
    // 用户预先改过此文件，对比工作树当前 hash 看 task 是否也改了
    let currentSha = '';
    try {
      currentSha = (await g.raw(['hash-object', '--', p])).trim();
    } catch {
      // hash-object 抛错通常是文件已不在工作树（被 task 删除）
    }
    const verdict = classifyOnePath({
      preSha: preExistingPaths[p],
      currentSha,
      fileExists: existsSync(join(projectPath, p)),
    });
    if (verdict === 'affected') affected.push(p);
    else if (verdict === 'mixed') mixed.push(p);
    // 'excluded' → 用户预先改、task 没动（或预改本身即删）→ 不碰
  }
  return { affectedPaths: affected, mixedDirtyPaths: mixed };
}
