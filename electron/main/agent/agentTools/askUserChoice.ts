/**
 * ask_user_choice —— Twin 在主对话里向用户提一个或多个「带选项的问题」，阻塞等用户点选。
 *
 * provider-agnostic：所有 backend 都 `await tool.execute()`，「阻塞 execute → 等用户 → 回灌结果」
 * 天然跨后端，不碰任何 SDK 专属机制。最贴近的样板是 ask_twin（execute await 一个 resolver 拿回答）。
 *
 * execute：校验 → 生成 askId → 经 ctx.askUserChoice 弹卡片并阻塞 → 拼回模型文本 + 结构化回答。
 * abort（用户停止 / 本轮报错）→ ctx.askUserChoice reject → execute 抛 → 现有中断回合落盘接住。
 *
 * 「我自己说」自由文本与「跳过」不进 schema——前端自动追加，模型不该控制这两个逃生口。
 */
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import type { AskUserChoiceAnswers, AskUserChoiceQuestion } from '@shared/types';
import { newAskId } from '@shared/ids';
import { awaitUserChoice, abortUserChoice } from '../../proposals/pendingUserChoice';

const MAX_QUESTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;

/**
 * 校验工具入参。跨 provider 通用约束：questions 1..4；每题 options 2..5。
 * 返回归一化后的 questions，或一句给模型看的纠错文本（让它改）。
 */
export function validateAskUserChoiceInput(
  input: unknown,
): { questions: AskUserChoiceQuestion[] } | { error: string } {
  const raw = input as { questions?: unknown };
  const questions = raw?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS) {
    return { error: `questions 必须是 1..${MAX_QUESTIONS} 个问题的数组` };
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as Partial<AskUserChoiceQuestion>;
    if (!q || typeof q.question !== 'string' || !q.question.trim()) {
      return { error: `第 ${i + 1} 题缺少 question 文本` };
    }
    if (typeof q.header !== 'string' || !q.header.trim()) {
      return { error: `第 ${i + 1} 题缺少 header 短标题` };
    }
    if (!Array.isArray(q.options) || q.options.length < MIN_OPTIONS || q.options.length > MAX_OPTIONS) {
      return { error: `第 ${i + 1} 题的 options 必须是 ${MIN_OPTIONS}..${MAX_OPTIONS} 个选项` };
    }
    for (let j = 0; j < q.options.length; j++) {
      const o = q.options[j];
      if (!o || typeof o.label !== 'string' || !o.label.trim()) {
        return { error: `第 ${i + 1} 题第 ${j + 1} 个选项缺少 label` };
      }
    }
  }
  return { questions: questions as AskUserChoiceQuestion[] };
}

/**
 * 把用户回答拼成给模型看的文本（技术设计 §7）。每题一行：
 * - 选了选项：`<header>：<label，逗号分隔>`
 * - 我自己说：`<header>：（我自己说）<freeText>`
 * - 跳过：`<header>：用户跳过`
 * 全部跳过 → `用户跳过了选择，请你自行判断。`
 */
export function formatAnswersForModel(
  questions: AskUserChoiceQuestion[],
  answers: AskUserChoiceAnswers,
): string {
  const byIndex = new Map(answers.answers.map((a) => [a.questionIndex, a]));
  const lines: string[] = [];
  let allSkipped = true;
  for (let i = 0; i < questions.length; i++) {
    const header = questions[i].header;
    const a = byIndex.get(i);
    if (a?.freeText && a.freeText.trim()) {
      allSkipped = false;
      lines.push(`${header}：（我自己说）${a.freeText.trim()}`);
    } else if (a?.selectedLabels && a.selectedLabels.length > 0) {
      allSkipped = false;
      lines.push(`${header}：${a.selectedLabels.join('，')}`);
    } else {
      lines.push(`${header}：用户跳过`);
    }
  }
  if (allSkipped) return '用户跳过了选择，请你自行判断。';
  return lines.join('\n');
}

export function makeAskUserChoiceTool(): AgentTool {
  return {
    name: 'ask_user_choice',
    mutatesEnvironment: false,
    description:
      '需要用户在几个方向里挑一个时使用——给一个或多个带选项的问题，用户在对话里点选作答。' +
      '每个选项可带一行说明让用户看清含义。用户也能「我自己说」自由作答或跳过（你自行判断）。' +
      '仅在主对话可用；动手前需要定调子的关键选择最适合用它。',
    // 不落 .tool-cache/——回答（含无上界的自由文本）在折叠层按工具豁免
    // （applyTier1Folding 的 NEVER_FOLD_TOOLS），原文常驻上下文，无需落盘取回。
    persistPolicy: 'never',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QUESTIONS,
          description: '1..4 个问题；一次可问多个，前端合并成一张卡逐题作答',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: '问题文本' },
              header: { type: 'string', description: '短标题，做顶部 tab（如「叙事重心」「视觉」）' },
              multiSelect: { type: 'boolean', description: '是否可多选，默认单选' },
              options: {
                type: 'array',
                minItems: MIN_OPTIONS,
                maxItems: MAX_OPTIONS,
                description: '2..5 个选项',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '选项名（简短）' },
                    description: { type: 'string', description: '一行说明，让用户看清这个选项意味着什么' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'header', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    async execute(input, ctx): Promise<ToolResult> {
      const validated = validateAskUserChoiceInput(input);
      if ('error' in validated) {
        return { isError: true, text: validated.error };
      }
      if (!ctx.askUserChoice) {
        return {
          isError: true,
          text: 'ask_user_choice 当前上下文不支持向用户提问（仅主对话可用）',
        };
      }
      // 与 propose_action 同步审批同构（见 emitProposal.ts）：先按 askId 挂 waiter（abort 用 ctx.abortSignal，
      // 同一来源就近读，不另外反查），再 emit 卡片，再 await。abort（用户停止 / 本轮报错）→ waiter reject →
      // 异常透传 → 现有中断回合落盘接住。
      const askId = newAskId();
      const pending = awaitUserChoice(ctx.agentId, ctx.conversationId, askId, validated.questions, ctx.abortSignal);
      try {
        await ctx.askUserChoice({ askId, questions: validated.questions });
      } catch (e) {
        abortUserChoice(askId); // reject 等待者清掉 waiter
        await pending.catch(() => {}); // 吸收上面这次 reject，避免未 await 的 promise 冒泡成 unhandledRejection
        return { isError: true, text: `弹出提问卡失败：${e instanceof Error ? e.message : String(e)}` };
      }
      const answers = await pending;
      // claude-code 后端 structured 由 MCP wrapper 统一搭桥送 stream.ts（见 claudeCode.ts buildToolsMcpServer）；
      // anthropic / openai 原生透传 structured。
      return {
        text: formatAnswersForModel(validated.questions, answers),
        structured: { answers: answers.answers },
      };
    },
  };
}
