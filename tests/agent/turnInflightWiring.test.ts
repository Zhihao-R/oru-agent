/**
 * 流式实时落盘 · 端到端接线（S03 / G22）。
 *
 * turnInflight.test.ts 覆盖草稿模块本身（写/清/扫描/幂等）；本文件验证它与 runner / stream /
 * runChatAndPersist 真接上了——否则有人删掉 runChatAndPersist 的 `finally { clearTurnInflight }`
 * 或 runner 的 onPartialUpdate 接线，模块单测仍绿而线断。
 *
 * 承重接线：
 *  1. 流中每产出一段（文字 / 悬空工具调用）就实时镜像进草稿——回合还没结束草稿已在盘上。
 *  2. 正式落盘（成功一条完整消息 / 优雅中断一条半截）后草稿被清除，不残留给下次启动误补。
 *
 * 真·进程崩溃（无 finally）无法在测试里模拟，其恢复路径由 turnInflight.test.ts 的模块层覆盖。
 *
 * ORU_DIR 范式 + __setBackendFactoryForTest 注入 stub backend（复用 runnerAbortMarker 手法）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationEvent, ConversationInput } from '@shared/agent/backend';

const ORU_DIR = join(tmpdir(), `oru-test-turn-inflight-wiring-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

// 'hang'=流出文字+悬空工具后挂起等 abort；'complete'=流出文字后正常收尾
let mode: 'hang' | 'complete' = 'hang';

function makeBackend(): AgentBackend {
  return {
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
    runConversation: (input: ConversationInput) => ({
      events: (async function* (): AsyncGenerator<ConversationEvent> {
        yield { type: 'assistant_text', text: mode === 'hang' ? '流式产出中' : '完整产出' };
        if (mode === 'hang') {
          yield { type: 'tool_use', id: 'tc1', name: 'bash', input: { cmd: 'sleep 999' } };
          // 悬空：不发 tool_result，挂起等用户按停
          await new Promise<never>((_, reject) => {
            const signal = input.abortController?.signal;
            if (!signal) return reject(new Error('stub 未拿到 abortController'));
            if (signal.aborted) return reject(new Error('Claude Code process aborted by user'));
            signal.addEventListener('abort', () => reject(new Error('Claude Code process aborted by user')), {
              once: true,
            });
          });
        }
        yield { type: 'result', resultText: '完整产出', isError: false };
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
  mode = 'hang';
});

function inflightPath(convId: string): string {
  return join(ORU_DIR, 'users', 'local-user', 'conversations', agentId, `${convId}.turn-inflight.json`);
}

async function setupTurn() {
  const { getAgent } = await import('../../electron/main/agent/store/agents');
  const { createConversation, appendMessage } = await import('../../electron/main/conversations/store');
  const { newMessageId } = await import('@shared/ids');
  const agent = await getAgent(agentId);
  const conversation = await createConversation({ agentId, title: '实时落盘接线', kind: 'sub' });
  await appendMessage(agentId, conversation.id, {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'user',
    text: '干活',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  });
  const args = {
    agent,
    conversation,
    messageId: newMessageId(),
    userText: '干活',
    emit: () => {},
    onSdkSessionId: async () => {},
    onProposal: async () => {},
  };
  return { agent, conversation, args };
}

describe('流式实时落盘 · 端到端接线', () => {
  it('流中实时写草稿（回合未结束草稿已在盘），用户中断落半截后草稿清除', async () => {
    const { conversation, args } = await setupTurn();
    const { runChatAndPersist } = await import('../../electron/main/ws/runChatAndPersist');
    const { abortConversation } = await import('../../electron/main/agent/runner');
    const draftPath = inflightPath(conversation.id);

    const pending = runChatAndPersist(args as never);

    // 回合还挂着——草稿应已实时落盘。文字先到（立即写），悬空工具调用在节流 trailing 落定后进草稿。
    let draft!: { messageId: string; partial: { resultText: string; toolCalls: Array<{ result?: unknown }> } };
    await vi.waitFor(
      () => {
        if (!existsSync(draftPath)) throw new Error('草稿尚未写');
        draft = JSON.parse(readFileSync(draftPath, 'utf-8'));
        if (draft.partial.toolCalls.length < 1) throw new Error('悬空工具尚未进草稿');
      },
      { timeout: 2000 },
    );
    expect(draft.messageId).toBe(args.messageId);
    expect(draft.partial.resultText).toContain('流式产出中');
    expect(draft.partial.toolCalls).toHaveLength(1);
    expect(draft.partial.toolCalls[0].result).toBeUndefined(); // 悬空

    // 用户中断 → 落半截 → finally 清草稿
    await vi.waitFor(() => {
      if (!abortConversation(agentId, conversation.id)) throw new Error('尚未起跑');
    });
    await pending;

    expect(existsSync(draftPath)).toBe(false); // 正式落盘后草稿清除
    const { readHistory } = await import('../../electron/main/conversations/store');
    const last = (await readHistory(agentId, conversation.id)).at(-1);
    expect(last!.interrupted).toBe('aborted');
    expect(last!.text).toContain('流式产出中');
  });

  it('正常跑完：完整消息落盘、草稿清除、无 interrupted', async () => {
    mode = 'complete';
    const { conversation, args } = await setupTurn();
    const { runChatAndPersist } = await import('../../electron/main/ws/runChatAndPersist');
    const draftPath = inflightPath(conversation.id);

    const outcome = await runChatAndPersist(args as never);
    expect(outcome).toBe('ok');

    expect(existsSync(draftPath)).toBe(false); // 成功后草稿清除
    const { readHistory } = await import('../../electron/main/conversations/store');
    const last = (await readHistory(agentId, conversation.id)).at(-1);
    expect(last!.interrupted).toBeUndefined();
    expect(last!.done).toBe(true);
    expect(last!.text).toContain('完整产出');
  });
});
