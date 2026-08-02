/**
 * 联网能力 —— 声明式能力机制的首个落地（含 subagentCoder）。
 *
 * 迁移即单源：web_search/web_fetch 已从 registerStaticAgentTools() 的 WEB 桶移除，
 * 改由本能力的 makeTools 注入；loadWebSearchPromptIfEnabled 的注入点从 runner.ts 移到
 * 本能力的 buildPrompt。系统里只剩这一处定义，无双注册 / 双 prompt 风险。
 */
import type { Capability } from '../types';
import { makeWebSearchTool } from '../../agentTools/webSearch';
import { makeWebFetchTool } from '../../agentTools/webFetch';
import { loadWebSearchPromptIfEnabled } from '../../webSearchPrompt';
import { resetConversationBudget } from '../../../search/budget';

export const webSearchCapability: Capability = {
  id: 'web-search',
  // 含 subagentCoder——它正是写 deck 的子 agent，本任务的核心目标；它跑在 ClaudeCode SDK
  // 原生文件工具集上，但仍可并行挂载 oru MCP 工具（实证：ask_twin/report_progress 就这样到它手上）。
  audience: ['twinMain', 'scheduledRun', 'twinBackground', 'twinSubagent', 'subagentCoder'],
  makeTools: [makeWebSearchTool, makeWebFetchTool],
  // enabled=false 返回空串，provision 过滤掉——模型看不到联网引导（默认关闭）。
  buildPrompt: () => loadWebSearchPromptIfEnabled(),
  initRuntime: async (ctx) => {
    // 用户每条新消息进入本轮时清零预算（子 agent 用独立桶，不占主对话）；
    // 同时把 searchBudgetId 注入 ToolContext，让 web_search/web_fetch 落到这个桶——
    // 由能力一处把"reset 的桶"和"consume 的桶"对齐，避免各 caller 手工设置漏掉。
    resetConversationBudget(ctx.searchBudgetId);
    return { searchBudgetId: ctx.searchBudgetId };
  },
  // SDK 内置 WebSearch/WebFetch 已进 DEFAULT_DENIED_BUILTINS 结构性关死（S04 网络出口收口），
  // 不再按能力逐次 disallow——两条压制管道留一条，避免死代码。
  claudeCodeTools: {
    allow: ['web_search', 'web_fetch'], // 放行 oru 工具（从实例级 ignoredToolNames 摘除）
  },
};
