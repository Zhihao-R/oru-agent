/**
 * 撞窗硬丢兜底同样推进上下文代际 · 回归测试
 *
 * 背景：read_file 的去重（同文件同范围 mtime 未变 → 只回一句「参考上次读取的内容」）默认
 * 「上次读到的内容还在模型上下文里」。折叠与摘要两条路已在 organizeContext 里推进代际让它失效，
 * 但 runner 还有第三条让内容离场的路——撞上下文窗口后被动整理仍装不下，用 dropOldestTurns
 * 逐轮硬丢最老的 user 轮。那条路走不到 organizeContext 的自增点（它的前提恰恰是 organizeContext
 * 返回 null），漏掉就会重演同一个假阳性：模型既拿不到内容、也没有强制重读的口子。
 *
 * 历史刻意压在「折叠与摘要都无事可做」的规模（3 条 user：不足折叠窗的 >3、不足摘要保留的 5），
 * 以保证代际是被硬丢那一处推进的，不是被 organizeContext 顺手推进的。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';

const ORU_DIR = join(tmpdir(), `oru-test-overflow-drop-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

const READ_PATH = '/tmp/oru-overflow-drop-fixture.csv';
const READ_STATE = { mtime: 111, content: 'a,b\n1,2', isPartialView: false };

/** 还剩几次要抛「超出上下文窗口」；抛完才正常返回 */
let overflowsLeft = 0;

function makeBackend(): AgentBackend {
  return {
    backendType: 'openai-compatible',
    toolProtocol: 'openai-fc',
    runConversation: (_input: ConversationInput) => {
      // 在 yield 任何事件之前抛——streamingStarted 仍为 false，runner 才会走撞窗兜底
      if (overflowsLeft > 0) {
        overflowsLeft -= 1;
        const e = new Error('maximum context length is 200000 tokens') as Error & { code: string };
        e.code = 'context_length_exceeded';
        throw e;
      }
      return {
        events: (async function* () {
          yield { type: 'result', resultText: '答完了', isError: false } as never;
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

/**
 * 起一个带 3 条 user 消息的对话，先记一次 read（此刻去重成立），再跑一轮。
 * 返回 convId 供调用方查回合之后去重还成不成立。
 */
async function seedReadThenRunTurn(): Promise<string> {
  const { getAgent } = await import('../../electron/main/agent/store/agents');
  const { createConversation, appendMessage } = await import('../../electron/main/conversations/store');
  const { recordRead, canSkipReread } = await import('../../electron/main/agent/conversationFileState');
  const { newMessageId } = await import('@shared/ids');
  const { runChatAndPersist } = await import('../../electron/main/ws/runChatAndPersist');

  const agent = await getAgent(agentId);
  const conversation = await createConversation({ agentId, title: '撞窗硬丢测试', kind: 'sub' });
  for (let i = 0; i < 3; i += 1) {
    await appendMessage(agentId, conversation.id, {
      id: newMessageId(),
      conversationId: conversation.id,
      role: 'user',
      text: `第 ${i + 1} 句`,
      toolCalls: [],
      createdAt: Date.now() + i,
      done: true,
    });
  }
  recordRead(conversation.id, READ_PATH, READ_STATE);
  // 前置条件：回合之前去重是成立的，否则后面断言 false 什么也证明不了
  expect(canSkipReread(conversation.id, READ_PATH, READ_STATE.mtime, undefined, undefined)).toBe(true);

  await runChatAndPersist({
    agent,
    conversation,
    messageId: newMessageId(),
    userText: '第 3 句',
    emit: () => {},
    onSdkSessionId: async () => {},
    onProposal: async () => {},
  });
  return conversation.id;
}

async function canSkip(convId: string): Promise<boolean> {
  const { canSkipReread } = await import('../../electron/main/agent/conversationFileState');
  return canSkipReread(convId, READ_PATH, READ_STATE.mtime, undefined, undefined);
}

describe('撞窗硬丢兜底（dropOldestTurns）推进上下文代际', () => {
  it('硬丢发生过 → 此前那次 read_file 不再算「内容还在上下文里」', async () => {
    overflowsLeft = 1;
    const convId = await seedReadThenRunTurn();
    expect(overflowsLeft).toBe(0); // 撞窗确实发生过，否则这条测试什么也没验
    expect(await canSkip(convId)).toBe(false);
  });

  it('没撞窗的正常回合 → 代际不动，去重照常生效（不误杀）', async () => {
    overflowsLeft = 0;
    const convId = await seedReadThenRunTurn();
    expect(await canSkip(convId)).toBe(true);
  });
});
