/**
 * 定时任务能力——工具 + prompt + 受众单一声明处。
 *
 * audience：主对话与背景 Twin（twinMain/twinBackground）能建/查定时任务；subagent 不需要
 * （它们是被派去干一次性活的，不该自行安排长期唤醒——也是「防自循环」护栏的一环）。
 */
import type { Capability } from '../types';
import {
  makeListScheduledTasksTool,
  makeManageScheduledTaskTool,
} from '../../agentTools/scheduledTasks';

const PROMPT = `你能维护一张「定时任务」清单——到某个时间自动替用户跑一段 prompt。

- 用户说「以后每天/每周……帮我做某事」「N 分钟后提醒我……」这类「到某个时间替我做某件事」时，
  用 manage_scheduled_task 建一条（写操作会先弹确认卡给用户）。
- 回答「我有哪些定时任务」「下一条几点触发」用 list_scheduled_tasks（只读、无需确认）。
- 挑节奏：具体时刻/「N 分钟后」→once；日常几点→daily；每周几→weekly；每隔几分钟/几小时循环→interval。
- 周期任务尽量带停止条件（stopAfterRuns：重复 N 次后停），避免无限循环。`;

export const scheduledTasksCapability: Capability = {
  id: 'scheduled-tasks',
  audience: ['twinMain', 'scheduledRun', 'twinBackground'],
  makeTools: [makeListScheduledTasksTool, makeManageScheduledTaskTool],
  buildPrompt: async () => PROMPT,
  // claude-code 后端默认忽略未知 oru 工具，显式放行（对齐 webSearch）
  claudeCodeTools: { allow: ['list_scheduled_tasks', 'manage_scheduled_task'] },
};
