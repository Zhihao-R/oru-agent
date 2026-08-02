/**
 * ask_user_choice 注册 + 跨后端可用性单测。
 *
 * 跨后端的本质保证：injectTools 是 backend-type 无关的同一段循环——凡 usages 含当前 usage 的工具
 * 都 backend.registerTool 进去（anthropic / openai / claude-code 一视同仁）。所以「provider-agnostic」
 * 归结为一个可验证事实：ask_user_choice 注册在 twinMain 桶里（主对话用 + subagent 透明继承）。
 *
 * SDK 内置 AskUserQuestion 被关掉一事是 claudeCode.ts 的常量黑名单，由 typecheck + 集成 smoke 覆盖。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { registerStaticAgentTools } from '../../electron/main/agent/agentTools';
import { __listRegisteredToolsForTest } from '../../electron/main/agent/backends';

describe('ask_user_choice 注册', () => {
  beforeAll(() => {
    registerStaticAgentTools();
  });

  it('注册在 twinMain 桶（cross-backend 注入前提；subagent 经透明继承）', () => {
    const entry = __listRegisteredToolsForTest().find((e) => e.tool.name === 'ask_user_choice');
    expect(entry).toBeTruthy();
    expect(entry!.usages).toContain('twinMain');
  });

  it('persistPolicy=never（结构化短文本回答不落 .tool-cache/）', () => {
    const entry = __listRegisteredToolsForTest().find((e) => e.tool.name === 'ask_user_choice');
    expect(entry!.tool.persistPolicy).toBe('never');
  });
});
