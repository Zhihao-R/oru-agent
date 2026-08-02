/**
 * read_background_output —— 按编号读后台命令的累积输出（S19·G16）。
 *
 * 后台命令（bash run_in_background=true）的输出不进对话、边流边落盘留后台，本工具让模型按 taskId
 * （bash-bg-…）随时读回最近输出 + 当前状态（在跑 / 已结束+退出码 / 停滞 / 崩溃）。补的是 subagent.html#A2
 * 「异步·中途查看」对后台命令那一半：模型能主动查，因为它没被阻塞。完成后由完成触发（G15）另行知会。
 */
import type { AgentTool } from '@shared/agent/backend';
import {
  type BackgroundCommandStatus,
  getBackgroundCommand,
  readBackgroundOutputTail,
} from '../../proposals/backgroundCommandStore';

const STATUS_LABEL: Record<BackgroundCommandStatus, string> = {
  running: '仍在运行',
  exited: '已结束',
  crashed: '因崩溃中断（进程随上次异常退出消失）',
};

export function makeReadBackgroundOutputTool(): AgentTool {
  return {
    name: 'read_background_output',
    mutatesEnvironment: false,
    description: `读你用 bash（run_in_background=true）在后台启动的命令的累积输出 + 当前状态。

**该用**：后台命令还在跑时想看它进展到哪了（构建/测试的日志）；收到「后台命令已结束」通知后想看完整输出定成败下一步。

**别用**：查后台 subagent 任务（Task(mode='async') 派的）→ 用 check_subagent_progress。

入参 task_id 就是启动时返回的编号（形如 bash-bg-…）。只回最近一段输出（尾部），够看最新进展。`,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '后台命令编号（启动时返回的 bash-bg-…）' },
      },
      required: ['task_id'],
    },
    async execute(input, ctx) {
      const taskId = (input as { task_id?: string })?.task_id;
      if (typeof taskId !== 'string' || !taskId.trim()) {
        return { isError: true, text: 'read_background_output: 缺少 task_id' };
      }
      const rec = await getBackgroundCommand(ctx.ownerId, taskId);
      if (!rec) {
        return { isError: true, text: `找不到后台命令 ${taskId}（编号错了，或该对话未起过它）。` };
      }
      const tail = await readBackgroundOutputTail(ctx.ownerId, taskId);
      const statusLine =
        `命令：${rec.command}\n状态：${STATUS_LABEL[rec.status]}` +
        (rec.status === 'exited'
          ? rec.timedOut
            ? '（长时间无新输出被判停滞、已终止）'
            : `（退出码 ${rec.exitCode}）`
          : '');
      return { text: `${statusLine}\n\n输出：\n${tail || '(暂无输出)'}` };
    },
  };
}
