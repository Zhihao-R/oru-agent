/**
 * escalate_to_user 的 AgentTool 形态——背景 Twin（处理子 agent 反问时）用。
 *
 * 通过 ToolContext.taskId + ToolContext.escalateHandler 完成回调。
 * factory 静态注册时 usages: ['twinBackground']。
 */
import type { AgentTool } from '@shared/agent/backend';

export function makeEscalateToUserTool(): AgentTool {
  return {
    name: 'escalate_to_user',
    mutatesEnvironment: false,
    description:
      '当你判断自己无法很好回答子 agent 的提问、或这个决策必须由用户来做时，使用本工具把问题转交给用户。' +
      '调用后子 agent 会等用户回答。',
    // v0.4：跟 ask_twin 对称——升级类工具的回执即便长也属"全文型"，统一 never
    persistPolicy: 'never',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题，应已包含必要上下文' },
      },
      required: ['question'],
    },
    async execute(input, ctx) {
      const args = input as { question: string };
      if (!ctx.taskId || !ctx.escalateHandler) {
        return {
          isError: true,
          text: 'escalate_to_user 当前不可用——本次 query 不在 task 反问上下文中',
        };
      }
      try {
        await ctx.escalateHandler(ctx.taskId, args.question);
        return {
          text: '已把问题转给用户，等待用户回答（任务暂停在 awaiting_user 状态）',
        };
      } catch (e) {
        return {
          isError: true,
          text: `escalate 失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}
