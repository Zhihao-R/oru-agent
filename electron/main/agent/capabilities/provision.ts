/**
 * 能力供给阶段二 —— prompt + ToolContext + disallowed 聚合。
 *
 * 三个 caller（runner.ts / subagentChat/runner.ts / tasks/subagentRunner.ts）在拼 system
 * prompt 处各调一次 provisionAgent，把三个返回值分别叠到自己已有的拼装上。
 * buildStableSystemContext 不被替换——provisionAgent 是叠加在它之上的一层。
 *
 * 阶段一（backend 供给：removeFromIgnoredTools）在 factory.injectTools 里，
 * 时刻不同（改工具注册必须早于注入循环），见技术设计 §2.3。
 */
import type { ToolContext } from '@shared/agent/backend';
import { getCapabilitiesForUsage } from './registry';
import type { CapabilityContext } from './types';

export type AgentProvision = {
  /** 拼好的能力 prompt 片段（已过滤空串） */
  capabilityPrompt: string;
  /** merge 进 toolContext */
  toolContextPatch: Partial<ToolContext>;
  /** 追加进 runConversation.disallowedTools */
  extraDisallowed: string[];
};

export async function provisionAgent(ctx: CapabilityContext): Promise<AgentProvision> {
  const caps = getCapabilitiesForUsage(ctx.usage);
  const prompts: string[] = [];
  let toolContextPatch: Partial<ToolContext> = {};
  const extraDisallowed: string[] = [];

  for (const cap of caps) {
    if (cap.buildPrompt) {
      const p = await cap.buildPrompt(ctx);
      if (p && p.trim().length > 0) prompts.push(p.trim());
    }
    if (cap.initRuntime) {
      toolContextPatch = { ...toolContextPatch, ...(await cap.initRuntime(ctx)) };
    }
    if (cap.claudeCodeTools?.disallow) {
      extraDisallowed.push(...cap.claudeCodeTools.disallow);
    }
  }

  return {
    capabilityPrompt: prompts.join('\n\n---\n\n'),
    toolContextPatch,
    extraDisallowed,
  };
}
