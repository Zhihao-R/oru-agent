/**
 * Twin 调 commit_changes 工具时的实际执行
 * - 主进程做实际 git commit（LLM 不直接握 git）
 * - 用 task.affectedPaths 限定要 add 的文件
 * - commit hash 写回 SubagentTask.commitsCreated
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { getTask, updateTaskStatus } from '../tasks/store';
import { getProject } from '../projects/store';

export type CommitResult =
  | { ok: true; commitHash: string }
  | { ok: false; error: string };

export async function commitTask(taskId: string, message: string): Promise<CommitResult> {
  const task = await getTask(taskId);
  if (!task) return { ok: false, error: `task not found: ${taskId}` };
  if (!task.targetProjectId) return { ok: false, error: 'task has no target project' };
  let projectPath: string;
  try {
    const project = await getProject(task.targetProjectId);
    projectPath = project.path;
  } catch (e) {
    return { ok: false, error: `project not found: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!existsSync(join(projectPath, '.git'))) {
    return { ok: false, error: 'project is not a git repo' };
  }
  if (task.affectedPaths.length === 0) {
    return { ok: false, error: 'no affected paths to commit' };
  }

  const g = simpleGit({ baseDir: projectPath });
  try {
    // -A 处理已删除文件；-- 终止选项防止路径被当成 flag
    await g.raw(['add', '-A', '--', ...task.affectedPaths]);
    // 检查暂存区是否真的有内容（防止 0 改动 commit 失败）
    const diff = await g.raw(['diff', '--cached', '--name-only']);
    if (!diff.trim()) {
      return { ok: false, error: 'nothing staged after git add (paths may be unchanged)' };
    }
    await g.commit(message);
    const head = (await g.revparse(['HEAD'])).trim();
    // 把 endTag 推进到新 HEAD：rollback 检查冲突时，commit_changes 创建的 commit 不被
    // 误判为"用户后续覆盖"
    if (task.endTag) {
      try {
        await g.tag(['-f', task.endTag, head]);
      } catch {
        // tag 推进失败不阻断 commit
      }
    }
    await updateTaskStatus(taskId, task.status, {
      commitsCreated: [...task.commitsCreated, head],
    });
    return { ok: true, commitHash: head };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
