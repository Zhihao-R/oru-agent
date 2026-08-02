/**
 * 精确撤回单个 task 的改动
 *
 * 设计原则：
 * 1. 不动用户手动改的文件（限定 affectedPaths）
 * 2. 不丢 git history（已 commit 用 revert，不用 reset --hard）
 * 3. rollback 自身可撤销（执行前打 oru/pre-rollback-<rollbackId> tag）
 * 4. 默认要确认（auto rollback 由 tasks/subagentRunner.ts 失败时调用 skipConflictCheck=true）
 *
 * 12 场景对应：
 *  1. 跑完没 commit + 撤回           → reverse-apply diff to affectedPaths
 *  2. 跑完已 commit + 撤回           → git revert --no-commit each commit
 *  3. 已 push 已 commit + 撤回       → 同 2，警告由前端给（这里不分 push 状态）
 *  4. 多 task，撤回中间一个          → 同 1/2，按 affectedPaths 精确反向
 *  5. 用户手动改别的文件            → 不动（affectedPaths 限定）
 *  6. 用户手动改同文件              → 触发 conflictPaths，UI 让用户决定
 *  7. 多 task 改同文件              → 同 6 处理
 *  8. task 跑到一半失败              → 自动 rollback（skipConflictCheck=true）
 *  9. task 新建文件                  → fs.rm（未跟踪）/ git rm（已跟踪）
 * 10. task 删除文件                  → git checkout <baselineTag> -- <path>
 * 11. task 重命名文件                → 通过 baselineTag 的 checkout 自然恢复
 * 12. rollback 的 rollback           → 由 oru/pre-rollback-<rollbackId> tag 支持 redo（router 处理）
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { newRollbackId } from '@shared/ids';
import { getTask, updateTaskStatus } from '../tasks/store';
import { getProject } from '../projects/store';

export type RollbackResult =
  | { ok: true; preRollbackTag: string | null; revertedCommits: number; revertedPaths: string[] }
  | { ok: false; error: 'conflict'; conflictPaths: string[] }
  | { ok: false; error: 'no-baseline' | 'no-project' | 'not-git' | 'task-not-found' | 'failed'; detail?: string };

export type RollbackOpts = {
  /** 跳过冲突检查（任务自身失败/取消的自动 rollback 用） */
  skipConflictCheck?: boolean;
};

/** `git diff --name-only` 输出 → 去空白去空行的路径列表（纯解析，便于单测冲突判定）。 */
export function parseGitDiffOutput(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 从 task.summary 解析 redo 用的 pre-rollback tag（hack——下次重构用专门字段）。
 * 抽成纯函数便于钉住正则：只认 `oru/pre-rollback-<id>` 形态，取不到返回 null。
 */
export function extractRedoTag(summary: string | null | undefined): string | null {
  return summary?.match(/redo tag: (oru\/pre-rollback-[\w-]+)/)?.[1] ?? null;
}

export async function rollbackTask(taskId: string, opts: RollbackOpts = {}): Promise<RollbackResult> {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task-not-found' };
  if (!task.targetProjectId) return { ok: false, error: 'no-project' };

  let projectPath: string;
  try {
    const project = await getProject(task.targetProjectId);
    projectPath = project.path;
  } catch {
    return { ok: false, error: 'no-project' };
  }
  if (!existsSync(join(projectPath, '.git'))) return { ok: false, error: 'not-git' };

  const baselineRef = `oru/baseline-${taskId}`;
  const endRef = task.endTag ?? 'HEAD';

  const g = simpleGit({ baseDir: projectPath });

  // 1. baseline 必须存在（git tag）
  try {
    await g.raw(['rev-parse', baselineRef]);
  } catch {
    // 旧 task 可能没有 tag，回退到 baselineCommit
    if (!task.baselineCommit) return { ok: false, error: 'no-baseline' };
  }
  const baselineForApply = (await tagExists(g, baselineRef)) ? baselineRef : task.baselineCommit;
  if (!baselineForApply) return { ok: false, error: 'no-baseline' };

  // 2. 冲突检查：endTag..HEAD 中是否有 affectedPaths 被再改
  if (!opts.skipConflictCheck && task.affectedPaths.length > 0 && task.endTag) {
    try {
      const out = await g.raw([
        'diff',
        '--name-only',
        `${task.endTag}..HEAD`,
        '--',
        ...task.affectedPaths,
      ]);
      const conflictPaths = parseGitDiffOutput(out);
      if (conflictPaths.length > 0) {
        return { ok: false, error: 'conflict', conflictPaths };
      }
    } catch {
      // diff 失败不阻止；继续尝试
    }
  }

  // 3. 打 pre-rollback tag 锁定 redo 点
  const rollbackId = newRollbackId();
  const preRollbackTag = `oru/pre-rollback-${rollbackId}`;
  let preRollbackTagged = false;
  try {
    const head = (await g.revparse(['HEAD'])).trim();
    await g.tag([preRollbackTag, head]);
    preRollbackTagged = true;
  } catch {
    // tag 创建失败不阻断
  }

  let revertedCommits = 0;
  const revertedPaths: string[] = [];

  try {
    // 4. 已 commit：用 revert（保留 history）
    if (task.commitsCreated.length > 0) {
      // 倒序 revert：最后一个 commit 先 revert
      const reversed = [...task.commitsCreated].reverse();
      for (const c of reversed) {
        try {
          await g.raw(['revert', '--no-edit', c]);
          revertedCommits++;
        } catch (e) {
          // revert 冲突 → 自动 abort 让工作树回到 revert 前；不留脏状态给用户
          try {
            await g.raw(['revert', '--abort']);
          } catch {
            // abort 失败一般是没有正在进行的 revert（前面 raw 实际上失败前已经写入冲突标记）
          }
          // 倒序 revert 到一半冲突：先前已提交的 revert 留着就是"部分回滚"的不一致态。
          // reset --hard 回 preRollbackTag（rollback 起点 HEAD），把已落的 revert 一并撤掉，
          // 让仓库整体回到没动过的样子（L4）。preRollbackTag 没建成则保持原样、不冒进。
          if (preRollbackTagged && revertedCommits > 0) {
            try {
              await g.raw(['reset', '--hard', preRollbackTag]);
            } catch {
              // reset 失败（极少）——退回到旧行为：留部分 revert，由 detail 提示用户手动处理
            }
          }
          const reason = e instanceof Error ? e.message : String(e);
          const cleanReason = reason.includes('CONFLICT')
            ? `commit ${c.slice(0, 7)} 之后用户改过同文件，git revert 冲突。请手动决定保留哪版`
            : reason;
          return {
            ok: false,
            error: 'failed',
            detail: `git revert 失败：${cleanReason}`,
          };
        }
      }
    } else if (task.affectedPaths.length > 0) {
      // 5. 没 commit：reverse-apply diff（限定到 affectedPaths）
      // 5.1 先 stash 用户在 affectedPaths 之外的改动以保护
      // 简化：跳过 stash 步骤；直接 checkout from baseline
      // 用 git checkout <baselineRef> -- <paths> 精确恢复（可处理新建/删除/重命名）
      try {
        await g.raw(['checkout', baselineForApply, '--', ...task.affectedPaths]);
        revertedPaths.push(...task.affectedPaths);
      } catch (e) {
        // 可能是 baseline 中不存在的文件（task 新建）—— 单独处理
        // 退而求其次：逐个 path 尝试，不存在的就 fs.rm
        const errMsg = e instanceof Error ? e.message : String(e);
        // try one by one
        for (const p of task.affectedPaths) {
          try {
            await g.raw(['checkout', baselineForApply, '--', p]);
            revertedPaths.push(p);
          } catch {
            // baseline 中没这个文件 → task 新建的，删
            try {
              await g.raw(['rm', '-f', '--', p]);
              revertedPaths.push(p);
            } catch {
              // 已 untracked / 删除失败：忽略
            }
          }
        }
        if (revertedPaths.length === 0) {
          return { ok: false, error: 'failed', detail: errMsg };
        }
      }
    }

    // 6. 标记 task 为 rolled_back
    await updateTaskStatus(taskId, 'rolled_back', {
      summary:
        (task.summary ?? '') + `\n[已撤回 @ ${new Date().toISOString()}, redo tag: ${preRollbackTag}]`,
    });
    return { ok: true, preRollbackTag, revertedCommits, revertedPaths };
  } catch (e) {
    return {
      ok: false,
      error: 'failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 撤销刚才的 rollback（从 preRollbackTag 恢复 affectedPaths） */
export async function redoRollback(taskId: string): Promise<RollbackResult> {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: 'task-not-found' };
  if (task.status !== 'rolled_back') {
    return { ok: false, error: 'failed', detail: 'task not in rolled_back state' };
  }
  if (!task.targetProjectId) return { ok: false, error: 'no-project' };

  let projectPath: string;
  try {
    const project = await getProject(task.targetProjectId);
    projectPath = project.path;
  } catch {
    return { ok: false, error: 'no-project' };
  }

  // 找 preRollbackTag：从 task.summary 解析 redo tag（hack——下次重构用专门字段）
  const preRollbackTag = extractRedoTag(task.summary);
  if (!preRollbackTag) return { ok: false, error: 'failed', detail: 'no preRollbackTag found' };

  const g = simpleGit({ baseDir: projectPath });
  if (!(await tagExists(g, preRollbackTag))) {
    return { ok: false, error: 'failed', detail: `tag ${preRollbackTag} missing` };
  }

  try {
    if (task.affectedPaths.length > 0) {
      await g.raw(['checkout', preRollbackTag, '--', ...task.affectedPaths]);
    }
    // 还原 task 状态到 done（粗略——commitsCreated 的 revert commit 不会被撤销）
    await updateTaskStatus(taskId, 'done', {
      summary: (task.summary ?? '').replace(/\n\[已撤回 [^\]]+\]/, '\n[redo 恢复]'),
    });
    return { ok: true, preRollbackTag, revertedCommits: 0, revertedPaths: task.affectedPaths };
  } catch (e) {
    return {
      ok: false,
      error: 'failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function tagExists(g: ReturnType<typeof simpleGit>, tag: string): Promise<boolean> {
  try {
    await g.raw(['rev-parse', tag]);
    return true;
  } catch {
    return false;
  }
}
