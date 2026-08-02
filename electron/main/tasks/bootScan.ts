/**
 * 崩溃恢复·启动扫描（S19·G18）——认出上次异常退出时僵在「进行中」的派工 subagent 任务。
 *
 * 登记表跨重启存活，但此前无启动扫描：崩死的任务永远僵在 running（进度查询会报「已跑 37 小时」）。
 * 本模块在启动时把仍处 inflight（pending/running/awaiting_*）的任务判为「因崩溃中断」（interrupted）
 * ——**不自动重跑**（工作可能已有副作用），只落终态并交调用方合成「因崩溃中断」触发入队，由模型 / 用户
 * 决定是否重派。见 subagent.html#PFail「异步 + 进程崩溃」。
 */
import type { SubagentTask } from '@shared/types';
import { listAllTasks, updateTaskStatus } from './store';

// 「还没落终态」的状态集合（与 checkTasks 的 INFLIGHT 同口径）——启动时还挂着这些的必是崩溃遗留。
const INFLIGHT = new Set<SubagentTask['status']>([
  'pending',
  'running',
  'awaiting_twin',
  'awaiting_user',
]);

/**
 * 扫悬空任务、判为 interrupted、返回被恢复的任务供调用方合成完成触发。
 * 幂等：已落终态的不动；本次判为 interrupted 的下次启动已是终态、不再命中。
 */
export async function scanDanglingTasksOnBoot(): Promise<SubagentTask[]> {
  const all = await listAllTasks().catch(() => [] as SubagentTask[]);
  const dangling = all.filter((t) => INFLIGHT.has(t.status));
  const recovered: SubagentTask[] = [];
  for (const t of dangling) {
    const patched = await updateTaskStatus(t.id, 'interrupted', {
      errorMessage: '因崩溃中断（应用上次未正常退出，任务未跑完）',
      finishedAt: Date.now(),
    }).catch(() => null);
    if (patched) recovered.push(patched);
  }
  return recovered;
}
