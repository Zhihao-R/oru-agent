/**
 * check_subagent_progress —— 主对话 AI 现查本对话派出的后台编码任务的实时状态。
 *
 * 补的是「在场即时可见性」缺口：Task(mode='async') 派出的后台 task 跑在独立进程，task.progress /
 * task.statusChanged 只进前端 UI 卡片，从不进主对话 AI 的上下文；而回合起点的「已完成未播报」
 * hint 只在一轮开头拍一次快照、且只收终态。于是用户在 task 还在跑时问「咋样了」，主对话 AI
 * 既看不到在跑的 task、也看不到这一轮中途才落终态的 task，只能凭记忆猜 + 退化去 list_dir 扒磁盘。
 *
 * 本工具让它能主动 pull：在跑 / 排队 / 等答疑 / 等用户的任务给状态 + 已跑时长 + 最近一次活动；
 * 刚完成 / 失败但还没播报的给结果，并就地 markAnnounced——既然主对话 AI 已经看到、会向用户
 * 转述，就别让终态主动播报再重复念一遍（与回合起点 hint 同一去重口径）。
 *
 * 三条可见性通道分工，互不重叠：
 * - 本工具（pull · 回合进行中现查）：治「用户在场干等、过程中问进度」。
 * - 回合起点 hint（push · 快照）：每轮开头把「已完成未播报」塞进上下文，治「离开一会回来」。
 * - 终态主动播报 taskAnnouncer（push · 事件）：task 落终态且对话空闲时 Twin 主动开口，治「完全没在看」。
 *
 * tasks/store 不被 agent/* 直接 import（解 agent ↔ tasks 循环）——store 能力经
 * agent/tasksGateway 由 main 启动期统一注入，execute 时惰性读（与 hooks 共用同一闸门）。
 */
import type { AgentTool } from '@shared/agent/backend';
import type { SubagentTask, TaskStatus } from '@shared/types';
import { tasksGateway, type TasksGateway } from '../tasksGateway';

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '排队中',
  running: '运行中',
  awaiting_twin: '答疑中（系统自动处理）',
  awaiting_user: '等待你回答追问',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  rolled_back: '已回滚',
  interrupted: '已中断',
};

// 「在跑」语义集合：还没落终态的全部状态
const INFLIGHT: TaskStatus[] = ['pending', 'running', 'awaiting_twin', 'awaiting_user'];

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m} 分 ${rem} 秒` : `${m} 分`;
}

async function latestOpenQuestion(
  getQuestions: TasksGateway['getQuestions'],
  taskId: string,
): Promise<string | null> {
  try {
    const qs = await getQuestions(taskId);
    // answeredAt === null 才算还没答上（answer 字段仅 escalate 到用户后才填，不能用它判）
    const open = qs.filter((q) => q.answeredAt === null);
    const last = open[open.length - 1];
    return last ? last.question.slice(0, 200) : null;
  } catch {
    return null;
  }
}

export function makeCheckSubagentTasksTool(): AgentTool {
  return {
    name: 'check_subagent_progress',
    mutatesEnvironment: false,
    description: `查本对话里你用 Task(mode='async') 派出去的「后台 subagent」此刻的实时状态与进度（在跑 / 排队 / 等答疑 / 等用户 / 刚完成 / 失败）。

**该用（只在用户主动问时调）**：用户在后台任务还没结束时问「咋样了 / 好了没 / 进度如何」。这是唯一的触发条件——除此之外**不要主动调本工具**：任务跑没跑完、进度到哪儿，都会由系统自己播报给你，不需要你轮询确认；你主动反复查反而会打断流程、制造多余播报。

**别用**：查用户的待办清单（看板）→ 那是 list_tasks，不是这个；用户没问进度时自己跑去确认任务状态 → 也不需要，等系统播报即可。

无参数，默认查当前对话下所有后台编码任务。

副作用：列出的「刚完成 / 失败」任务会就地标记为已播报，系统不会再主动播一遍——结果你已看到并能转述给用户；若此时用户没在等，就如实告诉他任务已结束，别为播报而多查。`,
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      const { listTasksForConversation, markAnnounced, getLastProgress, getQuestions } =
        tasksGateway();
      let tasks: SubagentTask[];
      try {
        tasks = await listTasksForConversation(ctx.conversationId);
      } catch (e) {
        return { isError: true, text: `查后台任务失败：${String(e)}` };
      }

      const inflight = tasks.filter((t) => INFLIGHT.includes(t.status));
      const terminalNews = tasks.filter(
        // interrupted = 启动扫描认出的崩溃遗留（G18）：也算「刚结束、该同步」
        (t) =>
          (t.status === 'done' || t.status === 'failed' || t.status === 'interrupted') &&
          !t.announcedAt,
      );

      if (inflight.length === 0 && terminalNews.length === 0) {
        return { text: '本对话没有在跑的后台编码任务，也没有刚结束、还没同步给你的任务。' };
      }

      const now = Date.now();
      const sections: string[] = [];

      if (inflight.length > 0) {
        const lines = ['【进行中】'];
        for (const t of inflight) {
          let line = `- task ${t.id}（${t.proposalTitle}）：${STATUS_LABEL[t.status]}，已跑 ${fmtElapsed(now - t.startedAt)}`;
          if (t.status === 'awaiting_user') {
            const q = await latestOpenQuestion(getQuestions, t.id);
            if (q) line += `；在等你回答：「${q}」`;
          } else {
            const prog = await getLastProgress(t.id).catch(() => null);
            if (prog) line += `；最近：${prog}`;
          }
          lines.push(line);
        }
        sections.push(lines.join('\n'));
      }

      if (terminalNews.length > 0) {
        const lines = ['【刚结束（这就同步给你；说完会标记已播报，避免系统重复念一遍）】'];
        for (const t of terminalNews) {
          lines.push(
            `- task ${t.id}（${t.proposalTitle}）：${STATUS_LABEL[t.status]}` +
              (t.summary ? `，摘要：${t.summary.slice(0, 200)}` : '') +
              (t.errorMessage ? `，错误：${t.errorMessage.slice(0, 200)}` : ''),
          );
          await markAnnounced(t.id);
        }
        sections.push(lines.join('\n'));
      }

      return { text: sections.join('\n\n') };
    },
  };
}
