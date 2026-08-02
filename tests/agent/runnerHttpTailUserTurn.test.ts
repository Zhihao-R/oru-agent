/**
 * runner 起流前对 HTTP 后端补齐末尾 user 轮（ensureCurrentTurnInHistory 的 runner 接线）。
 *
 * 背景：七条「非用户发起」路径（[重试] / loop 干活轮第二轮起 / 审批续跑 / 断线自动接续 /
 * subagent 任务播报 / 后台命令播报 / 冲突裁决回报）都把当前轮输入只放在 userText（或没有），
 * history 末尾停在 assistant 轮。HTTP 后端只 replay history、不读 userMessage →
 * 撞 assertCurrentTurnInHistory 显式炸（[重试]/loop），或播报静默失败。
 *
 * 本测试用 openai-compatible 型 stub backend 捕获 runConversation 入参，验证 runner
 * 发出的 history 末尾已是合规 user 轮，且补齐轮**不落盘**（下轮重读不残留）。
 * ORU_DIR 范式 + __setBackendFactoryForTest 注入（复用 runnerSessionReload 手法）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';
import type { BackendType, ChatMessage, ToolProtocol } from '@shared/types';
import { CONTINUE_NOTE } from '../../electron/main/agent/backends/historyContract';

const ORU_DIR = join(tmpdir(), `oru-test-runner-tail-user-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

/** 每次 runConversation 的入参快照 */
const capturedInputs: ConversationInput[] = [];
let backendType: BackendType = 'openai-compatible';
let toolProtocol: ToolProtocol = 'openai-fc';

function makeBackend(): AgentBackend {
  return {
    backendType,
    toolProtocol,
    runConversation: (input: ConversationInput) => {
      capturedInputs.push(input);
      return {
        events: (async function* () {
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
  backendType = 'openai-compatible';
  toolProtocol = 'openai-fc';
});

/** 造一个「末尾停在 assistant 轮」的对话——七条非用户路径起跑时的共同形态 */
async function setupAssistantTailConversation(opts?: { interrupted?: boolean }) {
  const { getAgent } = await import('../../electron/main/agent/store/agents');
  const { createConversation, appendMessage } = await import(
    '../../electron/main/conversations/store'
  );
  const { newMessageId } = await import('@shared/ids');
  const agent = await getAgent(agentId);
  const conversation = await createConversation({ agentId, title: '末尾补齐测试', kind: 'sub' });
  const user: ChatMessage = {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'user',
    text: '查一下天气',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  };
  const assistant: ChatMessage = {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'assistant',
    text: '成都 7/24-7/30 晴……',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    ...(opts?.interrupted ? { interrupted: 'aborted' as const } : {}),
  };
  await appendMessage(agentId, conversation.id, user);
  await appendMessage(agentId, conversation.id, assistant);
  return { agent, conversation };
}

function baseArgs(agent: Awaited<ReturnType<typeof setupAssistantTailConversation>>['agent'], conversation: Awaited<ReturnType<typeof setupAssistantTailConversation>>['conversation'], userText: string | undefined, messageId: string) {
  return {
    agent,
    conversation,
    messageId,
    userText,
    emit: () => {},
    onSdkSessionId: async () => {},
    onProposal: async () => {},
  };
}

describe('HTTP 后端：runner 起流前补齐末尾 user 轮', () => {
  it('有 nudge（loop 干活轮 / 播报形态）→ history 末尾是 nudge 的 user 轮', async () => {
    const { agent, conversation } = await setupAssistantTailConversation();
    const { runChat } = await import('../../electron/main/agent/runner');
    const { newMessageId } = await import('@shared/ids');

    const result = await runChat(
      baseArgs(agent, conversation, '第一轮差一项：未来10天只查到7天，补齐', newMessageId()),
    );
    expect(result.isError).toBe(false);

    expect(capturedInputs).toHaveLength(1);
    const sent = capturedInputs[0].history ?? [];
    const tail = sent[sent.length - 1];
    expect(tail?.role).toBe('user');
    expect(tail?.text).toBe('第一轮差一项：未来10天只查到7天，补齐');
  });

  it('无 nudge（[重试] / 审批续跑形态，含中断半截）→ 末尾是系统记续跑 user 轮', async () => {
    const { agent, conversation } = await setupAssistantTailConversation({ interrupted: true });
    const { runChat } = await import('../../electron/main/agent/runner');
    const { newMessageId } = await import('@shared/ids');

    const result = await runChat(baseArgs(agent, conversation, undefined, newMessageId()));
    expect(result.isError).toBe(false);

    const sent = capturedInputs[0].history ?? [];
    const tail = sent[sent.length - 1];
    expect(tail?.role).toBe('user');
    expect(tail?.text).toBe(CONTINUE_NOTE);
  });

  it('补齐轮不落盘：下轮重读 history 无残留', async () => {
    const { agent, conversation } = await setupAssistantTailConversation();
    const { runChat } = await import('../../electron/main/agent/runner');
    const { readHistory } = await import('../../electron/main/conversations/store');
    const { newMessageId } = await import('@shared/ids');

    await runChat(baseArgs(agent, conversation, '补齐这一项', newMessageId()));

    const persisted = await readHistory(agentId, conversation.id);
    // 落盘的只有 setup 的 user+assistant 与本轮新 assistant 回复——不含临时补齐的 user 轮
    expect(persisted.filter((m) => m.role === 'user' && m.text === '补齐这一项')).toHaveLength(0);
  });

  it('claude-code 后端不补（userMessage/session 通道健在，别喂两遍）', async () => {
    backendType = 'claude-code';
    toolProtocol = 'sdk-mcp';
    const { agent, conversation } = await setupAssistantTailConversation();
    const { runChat } = await import('../../electron/main/agent/runner');
    const { newMessageId } = await import('@shared/ids');

    await runChat(baseArgs(agent, conversation, '继续引导', newMessageId()));

    const sent = capturedInputs[0].history ?? [];
    const tail = sent[sent.length - 1];
    expect(tail?.role).toBe('assistant'); // 原样透传
    expect(capturedInputs[0].userMessage).toBe('继续引导');
  });
});
