/**
 * env 下沉（M4 收口）：SDK 子进程 env 由 ClaudeCodeBackend 构造期持有、透传给 engine.run——
 * 不再从 ConversationInput.env 逐调用方传入（原散在 7 个调用方，HTTP 两后端根本不读它）。
 *
 * 真相源是「engine.run 实际收到的 env」。本测试在 engine 边界捕获断言：
 * - 构造期注入的 env 原样透传给 engine.run
 * - 未注入（undefined）→ engine.run 收到 undefined（不再有隐式来源）
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';
import type { ConversationInput } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const { runInputs } = vi.hoisted(() => ({ runInputs: [] as EngineRunInput[] }));

vi.mock('../../electron/main/engine', () => {
  async function* oneResult(): AsyncGenerator<EngineEvent> {
    yield { type: 'result', resultText: 'done', isError: false };
  }
  const engine = {
    run: (input: EngineRunInput): EngineRunHandle => {
      runInputs.push(input);
      return { events: oneResult() };
    },
    mcp: {
      createServer: () => ({}),
      defineTool: (name: string) => ({ name }),
    },
  } satisfies CodeExecutionEngine;
  return { engine };
});

import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';

const toolContext = makeToolContext({
  conversationId: 'conv-1',
  agentId: 'agent-1',
  ownerId: 'owner-1',
  approvalMode: 'work',
  usage: 'twinMain',
});

function makeInput(overrides: Partial<ConversationInput> = {}): ConversationInput {
  return {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    userMessage: '你好',
    cwd: process.cwd(),
    abortController: new AbortController(),
    toolContext,
    ...overrides,
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) void _;
}

describe('ClaudeCodeBackend env 下沉', () => {
  beforeEach(() => {
    runInputs.length = 0;
  });

  it('构造期注入的 env 原样透传给 engine.run', async () => {
    const env = { ANTHROPIC_API_KEY: 'sk-xyz', PATH: '/usr/bin' };
    const backend = new ClaudeCodeBackend('claude-x', { env });
    await drain(backend.runConversation(makeInput()).events);
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0].env).toEqual(env);
  });

  it('未注入 env → engine.run 收到 undefined（无隐式来源）', async () => {
    const backend = new ClaudeCodeBackend('claude-x');
    await drain(backend.runConversation(makeInput()).events);
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0].env).toBeUndefined();
  });

  it('runOneShot 同样透传构造期 env（子进程 BASE_URL 剥离对 oneShot 也生效）', async () => {
    const env = { ANTHROPIC_API_KEY: 'sk-oneshot' };
    const backend = new ClaudeCodeBackend('claude-x', { env });
    await backend.runOneShot({ prompt: '起个名字' });
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0].env).toEqual(env);
  });
});
