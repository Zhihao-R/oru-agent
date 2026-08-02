/**
 * runner 中断标记回归（2026-07 通知中心误报修复）：
 *
 * runChatAndPersist 判定「用户主动刹停」的唯一依据是 runner 挂在错误上的
 * interruptedTurn.reason（按 abortController.signal 状态判定，backend 无关、不靠错误文案）。
 * 修复前 runner 只在「半截非空」时挂 turn——用户在首 token 前按停（半截为空）就没有任何
 * abort 标记，下游把它当真错误 emit chat.error → 通知中心误报「需要你处理」。
 *
 * 1. 用户 abort 且半截为空 → 错误上仍挂 interruptedTurn，reason='aborted'（修复前红）。
 * 2. 对照：backend 抛真错误（signal 未 abort）且半截为空 → 不挂 turn（overflow 等
 *    「未产出就失败」维持原语义，防误伤）。
 *
 * ORU_DIR 范式 + __setBackendFactoryForTest 注入 stub backend（复用 runnerBusyLock 手法）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';
import { readInterruptedTurn } from '../../electron/main/agent/interrupted';

const ORU_DIR = join(tmpdir(), `oru-test-runner-abort-marker-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

// 行为开关：'hang-until-abort'=一个 token 不出、等 signal abort 后抛（模拟首 token 前按停）；
// 'throw'=直接抛真错误（signal 未 abort 的上游失败）
let mode: 'hang-until-abort' | 'throw' = 'hang-until-abort';

function makeBackend(): AgentBackend {
  return {
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
    runConversation: (input: ConversationInput) => ({
      events: (async function* () {
        if (mode === 'throw') throw new Error('模拟上游挂了');
        // 半截为空地挂着，直到用户按停——真实 backend 在 signal abort 后从流里抛错
        await new Promise<never>((_, reject) => {
          const signal = input.abortController?.signal;
          if (!signal) return reject(new Error('stub 未拿到 abortController'));
          if (signal.aborted) return reject(new Error('Claude Code process aborted by user'));
          signal.addEventListener(
            'abort',
            () => reject(new Error('Claude Code process aborted by user')),
            { once: true },
          );
        });
      })(),
    }),
    runOneShot: async () => ({ text: 'unused' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  } satisfies AgentBackend;
}

let agentId: string;
let restoreFactory: () => void;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  const { setTasksGateway } = await import('../../electron/main/agent/tasksGateway');
  const { listTasksForConversation, markAnnounced, getLastProgress, getQuestions } = await import(
    '../../electron/main/tasks/store'
  );
  setTasksGateway({ listTasksForConversation, markAnnounced, getLastProgress, getQuestions });
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
  const { __setBackendFactoryForTest } = await import('../../electron/main/agent/backends/factory');
  restoreFactory = __setBackendFactoryForTest(async () => makeBackend());
});

afterAll(async () => {
  restoreFactory();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  mode = 'hang-until-abort';
});

async function setupConversation() {
  const { getAgent } = await import('../../electron/main/agent/store/agents');
  const { createConversation, appendMessage } = await import(
    '../../electron/main/conversations/store'
  );
  const { newMessageId } = await import('@shared/ids');
  const agent = await getAgent(agentId);
  const conversation = await createConversation({ agentId, title: '刹停标记测试', kind: 'sub' });
  await appendMessage(agentId, conversation.id, {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'user',
    text: '刹停测试',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  });
  const args = {
    agent,
    conversation,
    messageId: newMessageId(),
    userText: '刹停测试',
    emit: () => {},
    onSdkSessionId: async () => {},
    onProposal: async () => {},
  };
  return { agent, conversation, args };
}

describe('runner 用户 abort 标记', () => {
  it('首 token 前按停（半截为空）→ 错误仍挂 interruptedTurn，reason=aborted', async () => {
    const { agent, conversation, args } = await setupConversation();
    const { runChat, abortConversation } = await import('../../electron/main/agent/runner');

    const pending = runChat(args);
    // 等 backend 真正起跑（stub 挂在 signal 等待上）再按停——过早 abort 会在占位前扑空
    await vi.waitFor(() => {
      if (!abortConversation(agent.id, conversation.id)) throw new Error('尚未起跑');
    });

    const err = await pending.then(
      () => {
        throw new Error('runChat 不应成功');
      },
      (e: unknown) => e,
    );
    const turn = readInterruptedTurn(err);
    expect(turn).not.toBeNull();
    expect(turn!.reason).toBe('aborted');
    // 半截确实为空——落盘与否由 buildInterruptedMessage 决定（空半截返回 null 不落空壳）
    expect(turn!.partial.resultText).toBe('');
    expect(turn!.partial.toolCalls).toHaveLength(0);
  });

  it('对照：上游真错误（signal 未 abort）且半截为空 → 不挂 interruptedTurn', async () => {
    const { args } = await setupConversation();
    const { runChat } = await import('../../electron/main/agent/runner');

    mode = 'throw';
    const err = await runChat(args).then(
      () => {
        throw new Error('runChat 不应成功');
      },
      (e: unknown) => e,
    );
    expect(readInterruptedTurn(err)).toBeNull();
  });
});
