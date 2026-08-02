/**
 * runner 的 asideMode 分支按评点设置取 backend（二期 §3）：
 * - asideMode:true 的回合：getBackendFor('asideComment')（短评与短聊同一个「轻 Oru」，
 *   浮层里前后两句必须是同一个脑子）；思考开关默认关 → ConversationInput.disableReasoning: true
 * - 普通回合零回归：仍走 'twinMain'，disableReasoning 缺席
 * - asideThinking: true 时 aside 回合不关思考
 *
 * ORU_DIR 范式 + __setBackendFactoryForTest 捕获 usage 与 runConversation 入参；
 * auth 模块 mock 掉（不依赖本机 Claude 登录态）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';
import type { LlmUsage } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-runner-aside-backend-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

const usageCalls: LlmUsage[] = [];
const conversationInputs: ConversationInput[] = [];

function makeBackend(): AgentBackend {
  return {
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
    runConversation: (input: ConversationInput) => {
      conversationInputs.push(input);
      return {
        events: (async function* () {
          yield { type: 'result' as const, resultText: '短聊回应', isError: false };
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
  // runner → buildRuntimeContext → hooks 依赖注入（生产路径在 main/index.ts 启动期）
  const { setTasksGateway } = await import('../../electron/main/agent/tasksGateway');
  const { listTasksForConversation, markAnnounced, getLastProgress, getQuestions } = await import(
    '../../electron/main/tasks/store'
  );
  setTasksGateway({ listTasksForConversation, markAnnounced, getLastProgress, getQuestions });
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
  const { __setBackendFactoryForTest } = await import(
    '../../electron/main/agent/backends/factory'
  );
  restoreFactory = __setBackendFactoryForTest(async (usage) => {
    usageCalls.push(usage);
    return makeBackend();
  });
});

afterAll(async () => {
  restoreFactory();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  usageCalls.length = 0;
  conversationInputs.length = 0;
});

async function runTurn(p: { kind: 'aside' | 'sub'; asideMode?: boolean }): Promise<void> {
  const { getAgent } = await import('../../electron/main/agent/store/agents');
  const { createConversation, appendMessage } = await import(
    '../../electron/main/conversations/store'
  );
  const { runChat } = await import('../../electron/main/agent/runner');
  const { newMessageId } = await import('@shared/ids');
  const agent = await getAgent(agentId);
  const conversation = await createConversation({ agentId, title: '测试', kind: p.kind });
  await appendMessage(agentId, conversation.id, {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'user',
    text: '这块怎么样',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  });
  await runChat({
    agent,
    conversation,
    messageId: newMessageId(),
    userText: '这块怎么样',
    emit: () => {},
    onSdkSessionId: async () => {},
    onProposal: async () => {},
    asideMode: p.asideMode,
  });
}

describe('runner asideMode 的 backend 路由与思考开关', () => {
  it('asideMode:true → getBackendFor("asideComment")，disableReasoning: true（默认不思考）', async () => {
    await runTurn({ kind: 'aside', asideMode: true });
    expect(usageCalls).toContain('asideComment');
    expect(usageCalls).not.toContain('twinMain');
    expect(conversationInputs.at(-1)!.disableReasoning).toBe(true);
  });

  it('普通回合零回归：走 twinMain，disableReasoning 缺席', async () => {
    await runTurn({ kind: 'sub' });
    expect(usageCalls).toContain('twinMain');
    expect(usageCalls).not.toContain('asideComment');
    expect(conversationInputs.at(-1)!.disableReasoning).toBeUndefined();
  });

  it('asideThinking: true → aside 回合不关思考（显式 false，放开 claude-code 默认压制）', async () => {
    const { updateSettings } = await import('../../electron/main/projects/store');
    await updateSettings({ asideThinking: true });
    try {
      await runTurn({ kind: 'aside', asideMode: true });
      // 三态：显式 false 才能压过 claude-code「默认压思考治慢」，让 aside 思考开关真生效。
      expect(conversationInputs.at(-1)!.disableReasoning).toBe(false);
    } finally {
      await updateSettings({ asideThinking: false });
    }
  });
});
