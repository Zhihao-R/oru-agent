/**
 * G112 整理即弃号重灌（runner 回合入口触发路径）。
 *
 * 回合入口 organizeContext 返回非 null（history 被折叠 / 摘要）→ runner 单点 invalidateSession：
 * 时序在发请求之前，所以本回合第一个 backend 请求就不带 resumeSessionId、且 onSdkSessionId(null)
 * 已持久清号。托管后端据「无 resumeId ＋ 有 history」走 renderSeedPrompt 灌整理后视图。
 *
 * organizeContext 用 vi.mock 强制返回非 null（真实触发需撞 50% 水位、成本高）——单列一文件，
 * 不污染 runnerSessionReload 里依赖真实 organize 返回 null 的 poison 用例。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';
import type { ChatMessage } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-runner-organize-reload-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

// 回合入口整理强制返回非 null——模拟「history 被折叠 / 摘要」这一弃号触发条件。
let organizeReturnsNonNull = false;
vi.mock('../../electron/main/agent/context/organize', () => ({
  organizeThreshold: (w: number) => Math.floor(w / 2),
  organizeContext: async (args: { history: ChatMessage[] }) =>
    organizeReturnsNonNull
      ? { trimmedHistory: args.history, foldedBefore: undefined, fallback: false }
      : null,
}));

const capturedInputs: ConversationInput[] = [];

function makeBackend(): AgentBackend {
  return {
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
    runConversation: (input: ConversationInput) => {
      capturedInputs.push(input);
      return {
        events: (async function* () {
          yield { type: 'result', resultText: '好了', isError: false } as never;
        })(),
      };
    },
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

async function run(sdkSessionId: string) {
  capturedInputs.length = 0;
  const { getAgent } = await import('../../electron/main/agent/store/agents');
  const { createConversation, appendMessage } = await import('../../electron/main/conversations/store');
  const { newMessageId } = await import('@shared/ids');
  const agent = await getAgent(agentId);
  const conversation = await createConversation({ agentId, title: '整理弃号测试', kind: 'sub' });
  conversation.sdkSessionId = sdkSessionId;
  await appendMessage(agentId, conversation.id, {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'user',
    text: '整理弃号',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  });
  const sdkSessionCalls: (string | null)[] = [];
  const { runChat } = await import('../../electron/main/agent/runner');
  const result = await runChat({
    agent,
    conversation,
    messageId: newMessageId(),
    userText: '整理弃号',
    emit: () => {},
    onSdkSessionId: async (sid: string | null) => {
      sdkSessionCalls.push(sid);
    },
    onProposal: async () => {},
  });
  return { result, sdkSessionCalls };
}

describe('G112 整理即弃号重灌', () => {
  it('回合入口整理返回非 null → 首个请求就不带 resumeSessionId + 清号', async () => {
    organizeReturnsNonNull = true;
    const { result, sdkSessionCalls } = await run('sess-before-organize');
    expect(result.isError).toBe(false);
    expect(capturedInputs).toHaveLength(1);
    // 弃号时序在发请求之前：第一个请求就已不带旧编号
    expect(capturedInputs[0].resumeSessionId).toBeUndefined();
    expect(sdkSessionCalls).toContain(null);
  });

  it('对照：整理无事可做（返回 null）→ 正常带 resumeSessionId、不清号', async () => {
    organizeReturnsNonNull = false;
    const { result, sdkSessionCalls } = await run('sess-live');
    expect(result.isError).toBe(false);
    expect(capturedInputs[0].resumeSessionId).toBe('sess-live');
    expect(sdkSessionCalls).not.toContain(null);
  });
});
