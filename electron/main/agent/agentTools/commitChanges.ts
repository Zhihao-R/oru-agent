/**
 * commit_changes 的 AgentTool 形态
 *
 * 把指定 task 的改动 commit 到项目 git。
 */
import type { AgentTool } from '@shared/agent/backend';
import { commitTask } from '../../git/commit';

export function makeCommitChangesTool(): AgentTool {
  return {
    name: 'commit_changes',
    mutatesEnvironment: true,
    description: `把指定 task 的改动 commit 到项目 git。

**该用**：subagent 已成功完成（task.status='completed'）且你判断"这一步可以收尾了"时调。

**别用**：
- task 还没 completed——别试图 commit 未完工的改动
- 用户没让你 commit 也没明确同意自动 commit——直接动手会让用户失去对 git 历史的控制；先问"这一步要 commit 吗"
- 当前不是 git 仓库——会返回错误，告诉用户先 git init

message 由你写：要简洁、贴当前项目的 commit 风格。主进程负责实际 git commit；你不直接动 git。

失败时按返回的错误原文告诉用户（如"不是 git 仓库""没有可提交的改动"等），不要换 message 重试。`,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '要 commit 的 task id（task-report 卡片里有）' },
        message: { type: 'string', description: 'commit message，遵循项目风格' },
      },
      required: ['task_id', 'message'],
    },
    async execute(input, _ctx) {
      const args = input as { task_id: string; message: string };
      const r = await commitTask(args.task_id, args.message);
      if (r.ok) {
        return { text: `已提交。commit hash: ${r.commitHash}` };
      }
      return { isError: true, text: `commit 失败: ${r.error}` };
    },
  };
}
