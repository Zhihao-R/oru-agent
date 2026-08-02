/**
 * runChat 忙锁并发回归（2026-07-03 审计：check-then-set 窗口）：
 *
 * 1. 并发双回合：AGENT_BUSY 检查与占位 set 之间原本夹着数个 await（getBackendFor /
 *    isReady / detectAuth / resolveApiKeyForSdk），每个 await 都让出 event loop——
 *    审批后自动续跑与用户 chat.send 并发时两个调用都能穿过检查：同一对话两轮并发写
 *    历史，且第二个 set 覆盖第一个 AbortController（Esc 只能停后者）。
 *    修复后占位与检查在同一同步段完成，恰好一个起跑、另一个收 AGENT_BUSY。
 *
 * 2. 失败释放：占位提前后，占位之后、真正起跑之前的 await 段任何失败
 *    （如 backend isReady 不 ok）都必须释放占位，否则对话被永久卡成忙。
 *
 * ORU_DIR 范式 + __setBackendFactoryForTest 注入 stub backend（async factory 保证
 * 检查后的 await 真正让出 event loop）；auth 模块 mock 掉（不依赖本机登录态）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';
import { ErrorCodes } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-runner-busy-lock-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

// keepAwake：runner 现在挂钩 acquire/release 顶住休眠。测试里 mock 掉，避免真 spawn caffeinate，
// 并用 spy 断言「占位才 acquire、释放才 release」（技术设计 §8 runner 挂钩）。
const keepAwakeSpy = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
vi.mock('../../electron/main/keepAwake', () => ({
  acquire: keepAwakeSpy.acquire,
  release: keepAwakeSpy.release,
  setEnabled: vi.fn(),
  disposeKeepAwake: vi.fn(),
}));

// isReady 的行为开关与起跑计数——backend 闭包实时读，beforeEach 重置
let readyOk = true;
let runConversationCalls = 0;

function makeBackend(): AgentBackend {
  return {
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
    runConversation: (_input: ConversationInput) => {
      runConversationCalls += 1;
      return {
        events: (async function* () {
          yield { type: 'result' as const, resultText: '回应', isError: false };
        })(),
      };
    },
    runOneShot: async () => ({ text: 'unused' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () =>
      readyOk ? { ok: true, hint: 'mock' } : { ok: false, hint: '模拟 backend 不可用' },
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
  restoreFactory = __setBackendFactoryForTest(async () => makeBackend());
});

afterAll(async () => {
  restoreFactory();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  readyOk = true;
  runConversationCalls = 0;
  keepAwakeSpy.acquire.mockClear();
  keepAwakeSpy.release.mockClear();
});

/** 建一个带一条 user 消息的新对话，返回 runChat 所需的公共参数工厂（messageId 每次现取） */
async function setupConversation() {
  const { getAgent } = await import('../../electron/main/agent/store/agents');
  const { createConversation, appendMessage } = await import(
    '../../electron/main/conversations/store'
  );
  const { newMessageId } = await import('@shared/ids');
  const agent = await getAgent(agentId);
  const conversation = await createConversation({ agentId, title: '忙锁测试', kind: 'sub' });
  await appendMessage(agentId, conversation.id, {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'user',
    text: '并发测试',
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  });
  const mkArgs = () => ({
    agent,
    conversation,
    messageId: newMessageId(),
    userText: '并发测试',
    emit: () => {},
    onSdkSessionId: async () => {},
    onProposal: async () => {},
  });
  return { agent, conversation, mkArgs };
}

describe('runChat 忙锁：check 与占位 set 必须同一同步段', () => {
  it('并发双回合：同一对话同时发起两次 runChat，恰好一个起跑、另一个收 AGENT_BUSY', async () => {
    const { agent, conversation, mkArgs } = await setupConversation();
    const { runChat, isConversationBusy } = await import('../../electron/main/agent/runner');

    // 同一同步段先后发起——第一个在检查后的首个 await 处让出 event loop，
    // 第二个的 AGENT_BUSY 检查随即执行；修复前两个都能穿过检查（本测试红）。
    const results = await Promise.allSettled([runChat(mkArgs()), runChat(mkArgs())]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as Error & { code?: string }).code).toBe(ErrorCodes.AGENT_BUSY);
    // 恰好一轮真正起跑——修复前两轮并发写历史
    expect(runConversationCalls).toBe(1);
    // 胜者跑完后忙锁已释放
    expect(isConversationBusy(agent.id, conversation.id)).toBe(false);
  });

  it('回合收尾清零断路器：上一轮攒的连续失败不跨回合泄漏（G01/G04 回归）', async () => {
    const { conversation, mkArgs } = await setupConversation();
    const { runChat } = await import('../../electron/main/agent/runner');
    const { noteToolCall, noteToolResult, evaluateTrip, CONSEC_FAILURE_LIMIT, __clearBreakersForTest } =
      await import('../../electron/main/agent/circuitBreaker');
    __clearBreakersForTest();

    // 模拟本对话已攒到跳闸阈值的连续失败（上一轮遗留）
    for (let i = 0; i < CONSEC_FAILURE_LIMIT; i++) {
      noteToolCall(conversation.id, i);
      noteToolResult(conversation.id, true);
    }
    expect(evaluateTrip(conversation.id)).toBe('consecutive-failures');

    // 跑完一整回合 → 收尾必须清零，否则下一轮第一个失败就误跳闸
    const r = await runChat(mkArgs());
    expect(r.isError).toBe(false);
    expect(evaluateTrip(conversation.id), '回合收尾未清零断路器 → 连续失败跨回合泄漏').toBeNull();
  });

  it('失败释放：占位之后、起跑之前 isReady 失败，忙锁被释放且随后可再次起跑', async () => {
    const { agent, conversation, mkArgs } = await setupConversation();
    const { runChat, isConversationBusy } = await import('../../electron/main/agent/runner');

    readyOk = false;
    await expect(runChat(mkArgs())).rejects.toMatchObject({ code: ErrorCodes.AGENT_NO_AUTH });
    // 失败路径必须释放占位——否则对话永久卡忙
    expect(isConversationBusy(agent.id, conversation.id)).toBe(false);

    // 恢复后同一对话能正常通过检查并起跑
    readyOk = true;
    const result = await runChat(mkArgs());
    expect(result.isError).toBe(false);
    expect(runConversationCalls).toBe(1);
    expect(isConversationBusy(agent.id, conversation.id)).toBe(false);
  });

  it('keepAwake 挂钩（技术设计 §8）：占位才 acquire、释放才 release，失败路径也成对', async () => {
    const { conversation, mkArgs } = await setupConversation();
    const { runChat } = await import('../../electron/main/agent/runner');

    // 正常跑完一整回合：acquire（占位）→ release（finally 释放）各恰一次
    const ok = await runChat(mkArgs());
    expect(ok.isError).toBe(false);
    expect(keepAwakeSpy.acquire).toHaveBeenCalledTimes(1);
    expect(keepAwakeSpy.release).toHaveBeenCalledTimes(1);

    // 失败路径同样成对（占位后起跑前 isReady 失败 → acquire 已发、finally 必 release）
    keepAwakeSpy.acquire.mockClear();
    keepAwakeSpy.release.mockClear();
    readyOk = false;
    await expect(runChat(mkArgs())).rejects.toMatchObject({ code: ErrorCodes.AGENT_NO_AUTH });
    expect(keepAwakeSpy.acquire).toHaveBeenCalledTimes(1);
    expect(keepAwakeSpy.release).toHaveBeenCalledTimes(1);
  });
});
