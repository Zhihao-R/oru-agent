/**
 * 子 agent（写代码）用的两个 AgentTool：ask_twin / report_progress
 *
 * 通过 ToolContext.taskId / askTwinResolver / progressEmit 完成回调。
 * factory 静态注册时 usages: ['subagentCoder']。
 */
import type { AgentTool } from '@shared/agent/backend';

export function makeAskTwinTool(): AgentTool {
  return {
    name: 'ask_twin',
    mutatesEnvironment: false,
    description:
      '当你不确定怎么做、需要主脑 Oru 决策时使用。context_paths 里的文件会提示给 Oru，它按需自行读取。' +
      '如果 Oru 也答不上，会自动转给用户，你会拿到用户的回答。',
    // v0.4：Twin 的回答是给子 agent 的指令性内容，属"全文型"——一律 never，避免预览截断关键指令
    persistPolicy: 'never',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '清晰的问题，最好包含 1-2 个候选方案' },
        context_paths: {
          type: 'array',
          items: { type: 'string' },
          description: '建议 Oru 参考的项目文件路径列表（相对项目根 or 绝对路径），Oru 会按需读取',
        },
      },
      required: ['question'],
    },
    async execute(input, ctx) {
      const args = input as { question: string; context_paths?: string[] };
      if (!ctx.taskId || !ctx.askTwinResolver) {
        return {
          isError: true,
          text: 'ask_twin 当前不可用——本次 query 不在子 agent task 上下文中',
        };
      }
      try {
        const answer = await ctx.askTwinResolver(ctx.taskId, args.question, args.context_paths ?? []);
        return { text: answer };
      } catch (e) {
        return {
          isError: true,
          text: `ask_twin 失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

export function makeReportProgressTool(): AgentTool {
  return {
    name: 'report_progress',
    mutatesEnvironment: false,
    description: '主动告知 UI 当前进度的简短描述，会显示在任务卡片折叠态的状态行。简短，一行内。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '当前在做什么的简短描述，比如"读取 login.tsx" / "改 3 个文件"' },
      },
      required: ['text'],
    },
    async execute(input, ctx) {
      const args = input as { text: string };
      if (!ctx.progressEmit) {
        // 没挂 emit 也不算错——静默接受
        return { text: 'progress reported (no emit attached)' };
      }
      ctx.progressEmit(args.text);
      return { text: 'progress reported' };
    },
  };
}
