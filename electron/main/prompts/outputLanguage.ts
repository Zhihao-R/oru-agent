/**
 * 输出语言 meta 规则（D4）——所有面向用户的产出跟【对话语言】走，不跟界面语言设置。
 *
 * 本规则用英文写：属类③工程指令，且系统 prompt 统一英文（详见技术设计 D5）。模型据此从
 * 对话历史自判语言，产出聊天回复 / 提案标题 / 动作描述 / 播报——界面切英文但用户仍中文聊天时
 * 仍回中文。把这条零散隐性规则（cadence 的"用户中文你中文…"）提升为覆盖全部用户面产出的显式 meta。
 *
 * 边界——无对话语言可判时（主动播报 tasks/taskAnnouncer、定时任务到点起新空对话
 * scheduledTasks/deliver）：由触发路径在 nudge 里显式给出回落语言（界面语言 Settings.language）。
 * 此处 meta 规则只声明"无可判时由触发上下文指定"，不内嵌具体语言——系统前缀是静态的、跨 owner
 * 复用，内嵌某一界面语言会污染 cache 且对多 owner 不正确。
 *
 * 收口待办（D5）：cadence.ts 的"用户中文你中文…"与 capture.ts 的"跟随对话语言"两处旧语言句与本
 * meta 语义重复（三处同源 = 漂移风险）。它们在 D5 重写 cadence/capture 为英文时一并撤、让本规则
 * 单一承载——别当永久三写。
 */
import { definePrompt } from './registry';

export const OUTPUT_LANGUAGE_RULE = definePrompt(
  {
    id: 'output-language',
    title: '输出语言规则',
    category: 'agent',
  },
  `## Output language

All user-facing output — chat replies, proposal titles, action descriptions, and announcements — must follow the language the user is speaking in this conversation, not the app's UI language setting. When a turn has no user message to judge the language from, its triggering context will state which language to use.`,
);
