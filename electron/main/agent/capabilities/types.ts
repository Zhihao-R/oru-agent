/**
 * 声明式能力供给 —— 核心类型
 *
 * "一个 agent 能做什么"过去散在四层（工具注册 / backend 过滤 / system prompt / ToolContext），
 * 求交集才知道某能力通不通；每加一个能力都要在三个 caller 各对齐一遍，漏了不报错（"对齐税"）。
 *
 * Capability 把这四件套捆成一个**可声明、可审查**的单元：面向哪些 agent、带哪些工具、
 * 贡献什么 prompt、要什么运行时上下文、在 ClaudeCodeBackend 上做什么工具协调。
 * 声明一次即覆盖受众里的所有 agent，差异在 audience 一处可查。
 *
 * 详见 docs/tech/2026-06-01-subagent-web-access-tech-design.md §2。
 */
import type { LlmUsage } from '@shared/types';
import type { AgentTool, ToolContext } from '@shared/agent/backend';

/**
 * 能持有能力的 agent 用途——LlmUsage 中真正"派出 agent"（跑工具循环）的子集，
 * 排除 conversationSummary/conversationTitle/asideComment 这类纯文本进出的一次性 one-shot（零工具、
 * 无从裁剪，"空清单本身即是一种裁剪"）。
 *
 * memoryDream（夜间记忆整理）也在内（S31·G47）：它跑完整 agent 循环、用记忆读写 + 整理专属工具，
 * 是"记忆整理"这一后台场景——纳入统一裁剪体系后，它的工具与守则由 memory-curation 能力一处声明、
 * 经 provisionAgent 装配，不再在 dream.ts 手工接线（对齐税同源消除）。
 *
 * 用 LlmUsage 的子集而非新造平行词表：与工具桶同一种语言，避免互相映射；同时收窄掉非 agent 的值，
 * 让"受众"类型自解释——不会出现 `audience: ['conversationTitle']` 这种无意义但能通过编译的声明。
 */
export type AgentUsage = Extract<
  LlmUsage,
  'twinMain' | 'twinBackground' | 'twinSubagent' | 'subagentCoder' | 'scheduledRun' | 'memoryDream'
>;

export type CapabilityContext = {
  usage: AgentUsage;
  /** 预算桶 id；子 agent 用独立 id，不占主对话配额 */
  searchBudgetId: string;
  activeProjectId: string | null;
};

export type Capability = {
  /** 唯一标识，用于日志与"能力清单"审查 */
  id: string;

  /** 受众：哪些 agent 获得这个能力。必须显式列出——差异即声明。 */
  audience: AgentUsage[];

  /** 本能力带来的 oru AgentTool（prompt-only 能力留空） */
  makeTools?: Array<() => AgentTool>;

  /** 贡献的 prompt 片段；返回空/null=本次不注入（用于 enabled flag 门控） */
  buildPrompt?: (ctx: CapabilityContext) => Promise<string | null>;

  /** 运行时：注入 ToolContext 字段 / 执行副作用（如预算初始化）。幂等。 */
  initRuntime?: (ctx: CapabilityContext) => Promise<Partial<ToolContext>>;

  /** 仅对 ClaudeCodeBackend 生效的工具协调（其它 backend 忽略） */
  claudeCodeTools?: {
    allow?: string[]; // 从 ignoredToolNames 摘除（放行 oru 工具）
    disallow?: string[]; // 追加到 runConversation.disallowedTools（禁 SDK 内置）
  };
};
