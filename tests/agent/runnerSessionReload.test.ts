/**
 * G112 整理即弃号重灌 + G54 污染检测后自动重灌（runner 侧接线）。
 *
 * 弃号 = 上报 onSdkSessionId(null) 持久清号 ＋ 置本回合本地标志（continue 重试一律不带
 * resumeSessionId，逼 backend 走重灌）。两个触发方共用同一条 invalidateSession——本文件测 G54
 * 污染触发方，G112 整理触发方（回合入口 organize 返回非 null）直测在 runnerOrganizeReload.test.ts：
 *   1. 会话污染：backend 抛 SessionPoisonError → 清号 ＋ 重试一次；重灌后再报错原样抛（至多一次）。
 *   2. 本地作废标志承重（快照竞态回归）：清号后 continue 重试读的是内存快照，靠标志才不带旧编号。
 *
 * ORU_DIR 范式 + __setBackendFactoryForTest 注入 stub backend（复用 runnerAbortMarker 手法）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';
import { SessionPoisonError } from '../../electron/main/agent/backends/sessionPoison';

const ORU_DIR = join(tmpdir(), `oru-test-runner-reload-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

/** 每次 runConversation 的入参快照 + 行为控制 */
const capturedInputs: ConversationInput[] = [];
// 前 N 次调用抛污染错误（模拟 backend 事件层判定后抛），之后成功
let poisonCallsRemaining = 0;

function makeBackend(): AgentBackend {
  return {
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
    runConversation: (input: ConversationInput) => {
      capturedInputs.push(input);
      const throwPoison = poisonCallsRemaining > 0;
      if (throwPoison) poisonCallsRemaining -= 1;
      return {
        events: (async function* () {
          if (throwPoison) {
            throw new SessionPoisonError('API Error: text content blocks must be non-empty');
          }
          yield { type: 'result', resultText: '干完了', isError: false } as never;
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

beforeEach(() => {
  capturedInputs.length = 0;
  poisonCallsRemaining = 0;
});

async function setupConversation(sdkSessionId: string) {
  const { getAgent } = await import('../../electron/main/agent/store/agents');
  const { createConversation, appendMessage } = await import(
    '../../electron/main/conversations/store'
  );
  const { newMessageId } = await import('@shared/ids');
  const agent = await getAgent(agentId);
  const conversation = await createConversation({ agentId, title: '弃号重灌测试', kind: 'sub' });
  // 有活 session 编号：污染前 resume 在用
  conversation.sdkSessionId = sdkSessionId;
  await appendMessage(agentId, conversation.id, {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'user',
    text: '重灌测试',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  });
  const sdkSessionCalls: (string | null)[] = [];
  const args = {
    agent,
    conversation,
    messageId: newMessageId(),
    userText: '重灌测试',
    emit: () => {},
    onSdkSessionId: async (sid: string | null) => {
      sdkSessionCalls.push(sid);
    },
    onProposal: async () => {},
  };
  return { agent, conversation, args, sdkSessionCalls };
}

describe('G54 污染检测后自动重灌', () => {
  it('污染一次 → 清号 + 重试一次成功；重试不带旧 resumeSessionId', async () => {
    poisonCallsRemaining = 1;
    const { args, sdkSessionCalls } = await setupConversation('sess-old');
    const { runChat } = await import('../../electron/main/agent/runner');

    const result = await runChat(args);
    expect(result.isError).toBe(false);

    // 两次调用：第一次带旧编号撞污染，第二次重灌不带编号
    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[0].resumeSessionId).toBe('sess-old');
    expect(capturedInputs[1].resumeSessionId).toBeUndefined();

    // 清号上报 null（持久作废）
    expect(sdkSessionCalls).toContain(null);
  });

  it('重灌后同回合再遇污染 → 原样抛，不无限重灌（至多一次）', async () => {
    poisonCallsRemaining = 2; // 两次都污染
    const { args } = await setupConversation('sess-old');
    const { runChat } = await import('../../electron/main/agent/runner');

    // 重灌后再炸原样抛（外层 catch 像普通 agent 失败一样包装，message 保留毒化文案）
    await expect(runChat(args)).rejects.toThrow('session poisoned');
    // 只重灌一次：调用两次后不再重试
    expect(capturedInputs).toHaveLength(2);
  });

  it('无污染 → 不清号、正常带 resumeSessionId、一次成功', async () => {
    const { args, sdkSessionCalls } = await setupConversation('sess-live');
    const { runChat } = await import('../../electron/main/agent/runner');

    const result = await runChat(args);
    expect(result.isError).toBe(false);
    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0].resumeSessionId).toBe('sess-live');
    expect(sdkSessionCalls).not.toContain(null); // 没触发弃号
  });
});
