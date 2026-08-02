/**
 * OAuth fallback 模型按 usage 重量级分档（回归：自我认知/记忆挑选器每轮被 4s 超时掐）
 *
 * 症状：未分配模型时，memoryRecall（能力/记忆挑选器，inject.ts 每轮串联跑、裹 4s 超时）回落到
 * 写死的 opus-4.8 → opus 子进程冷启动 + 全量推理跑不进 4s 预算 → ctl.abort() → SDK 抛
 * 「Claude Code process aborted by user」。根因是 fallback 一律 opus、不看 usage 重量级。
 *
 * 本测试钉住修复后的分档：
 * - 轻量档（memoryRecall / loopReviewer / conversationTitle）→ haiku
 * - 其余（twinMain / twinSubagent / conversationSummary / memoryDream / subagentCoder…）→ opus
 * 直接断言 ClaudeCodeBackend 构造时收到的 model 字符串——即真正喂给 SDK 的模型。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentBackend, ConversationHandle, OneShotResult } from '@shared/agent/backend';
import type { LlmUsage, Settings } from '@shared/types';

// 记录每次 ClaudeCodeBackend 构造收到的 model（第一个构造参数）
const ccModelCalls: Array<string | undefined> = [];

vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

// mock ClaudeCodeBackend——只捕获构造参数，不启动真实 SDK。
// implements AgentBackend：接口加字段时编译即红，杜绝假绿（CLAUDE.md 测试约定）。
vi.mock('../../electron/main/agent/backends/claudeCode', () => {
  class FakeClaudeCodeBackend implements AgentBackend {
    readonly backendType = 'claude-code' as const;
    readonly toolProtocol = 'sdk-mcp' as const;
    constructor(model?: string) {
      ccModelCalls.push(model);
    }
    registerTool(): void {}
    unregisterTool(): void {}
    runConversation(): ConversationHandle {
      throw new Error('本测试只验构造参数，不跑对话');
    }
    runOneShot(): Promise<OneShotResult> {
      throw new Error('本测试只验构造参数，不跑 oneShot');
    }
    async isReady(): Promise<{ ok: boolean; hint: string }> {
      return { ok: true, hint: '' };
    }
  }
  return { ClaudeCodeBackend: FakeClaudeCodeBackend };
});

import { getSettings } from '../../electron/main/projects/store';
import { getBackendFor, __clearToolRegistryForTest } from '../../electron/main/agent/backends/factory';
import { makeSettings } from '../helpers/settings';

// 全量未分配——每条 usage 都走 OAuth fallback
const EMPTY_ASSIGNMENTS = {
  twinMain: null,
  twinBackground: null,
  memoryDream: null,
  subagentCoder: null,
  conversationSummary: null,
  conversationTitle: null,
  twinSubagent: null,
  asideComment: null,
  loopReviewer: null,
  memoryRecall: null,
  scheduledRun: null,
};

function emptySettings(): Settings {
  return makeSettings({ modelAssignments: { ...EMPTY_ASSIGNMENTS } });
}

beforeEach(() => {
  ccModelCalls.length = 0;
  __clearToolRegistryForTest();
  vi.mocked(getSettings).mockResolvedValue(emptySettings());
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function fallbackModelFor(usage: LlmUsage): Promise<string | undefined> {
  ccModelCalls.length = 0;
  await getBackendFor(usage);
  expect(ccModelCalls, `${usage} 应走 ClaudeCodeBackend fallback（恰一次构造）`).toHaveLength(1);
  return ccModelCalls[0];
}

describe('OAuth fallback 模型按 usage 重量级分档', () => {
  it('轻量档回落 haiku：memoryRecall / loopReviewer / conversationTitle', async () => {
    for (const usage of ['memoryRecall', 'loopReviewer', 'conversationTitle'] as LlmUsage[]) {
      expect(await fallbackModelFor(usage), `${usage} 应回落轻量 haiku`).toBe('claude-haiku-4-5');
    }
  });

  it('重量/身份档仍回落 opus：twinMain / conversationSummary / memoryDream / subagentCoder', async () => {
    for (const usage of ['twinMain', 'conversationSummary', 'memoryDream', 'subagentCoder'] as LlmUsage[]) {
      expect(await fallbackModelFor(usage), `${usage} 应回落 opus`).toBe('claude-opus-4-8');
    }
  });

  it('twinSubagent 映射 twinMain → 仍走 opus（不因映射误入轻量档）', async () => {
    expect(await fallbackModelFor('twinSubagent')).toBe('claude-opus-4-8');
  });
});
