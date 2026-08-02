/**
 * 飞书入站连发合并 端到端集成（S1：乐观起回合 + 无产出才撤 + 消息分条，窗口 1s）——
 * 除「真 LLM / 真平台传输」外整条线全跑真的：
 *
 *   白名单连发 3 条 → gateway → admit 统一准入 → 第 1 条乐观起回合（桩 backend 无产出挂住）
 *   → 第 2/3 条在窗口内判「干净」→ restart 撤起（abortConversation 杀在飞请求、token 翻新、
 *   origins custody 过户、不触发 handback）→ 重起回合历史已含全部 3 条 → 一次回发、表情全清。
 *
 * 时序确定性：桩 backend 的每次调用都挂起，等测试显式放行或撤起 abort——重起链上「被撤回合
 * 是否已走到 runChat」两种分支都被覆盖，断言对二者同时成立。
 * 模板沿用 tests/platform/inboundOutbound.integration.test.ts（ORU_DIR + mock auth + __setBackendFactoryForTest）。
 */
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';
import type { PlatformAdapter } from '../../electron/main/platform/adapter';
import type { MessageEvent, ProcessingHandle, SendResult, SessionSource } from '@shared/platform/message';

const ORU_DIR = join(tmpdir(), `oru-test-burst-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

const { runCaptureSpy } = vi.hoisted(() => ({
  runCaptureSpy: vi.fn<(typeof import('../../electron/main/memory/capture'))['runCapture']>(),
}));
vi.mock('../../electron/main/memory/capture', () => ({
  runCapture: runCaptureSpy,
}) satisfies Pick<typeof import('../../electron/main/memory/capture'), 'runCapture'>);

/**
 * 连发桩 backend：每次调用先挂起（等测试放行或 abort），被 abort 的抛 AbortError（对齐真实
 * backend 的 abort 形态，runner 按 signal 判 reason='aborted'）；被放行的出文本。
 * calls 记录每次 ConversationInput 供断言（重起回合历史是否带全连发消息）。
 */
function makeHangBackend(replyText: string) {
  const calls: ConversationInput[] = [];
  const parked: Array<{ input: ConversationInput; release: () => void }> = [];
  const backend: AgentBackend = {
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
    runConversation: (input: ConversationInput) => {
      calls.push(input);
      return {
        events: (async function* () {
          await new Promise<void>((resolve) => {
            parked.push({ input, release: resolve });
            input.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          if (input.abortController.signal.aborted) {
            throw new DOMException('This operation was aborted', 'AbortError');
          }
          yield { type: 'result' as const, resultText: replyText, isError: false };
        })(),
      };
    },
    runOneShot: async () => ({ text: 'unused' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  } satisfies AgentBackend;
  /** 等终回合挂起：终回合是重起链上唯一未被 abort 的调用（被撤的都已被 supersede 杀掉）。 */
  const waitFinalParked = () =>
    vi.waitFor(() => expect(parked.some((p) => !p.input.abortController.signal.aborted)).toBe(true));
  /** 放行当前全部挂起的调用（已被 abort 的会走 AbortError 分支，不受影响）。 */
  const releaseAll = () => parked.splice(0).forEach((p) => p.release());
  return { backend, calls, waitFinalParked, releaseAll };
}

/** 假飞书 adapter：捕获 send +「处理中」表情的贴/清（幂等，按 messageId 对账）。 */
function makeFakeAdapter() {
  const sent: Array<{ chatId: string; content: string }> = [];
  const marked: string[] = [];
  const cleared: string[] = [];
  const adapter: PlatformAdapter = {
    platform: 'feishu',
    maxMessageLength: 8000,
    maxFileBytes: 1024,
    connect: async () => true,
    disconnect: async () => {},
    send: async (chatId, content): Promise<SendResult> => {
      sent.push({ chatId, content });
      return { ok: true, messageId: `m_send_${sent.length}` };
    },
    markProcessing: async (chatId, messageId): Promise<ProcessingHandle | null> => {
      marked.push(messageId);
      return { platform: 'feishu', chatId, messageId };
    },
    clearProcessing: async (handle) => {
      if (!cleared.includes(handle.messageId)) cleared.push(handle.messageId);
    },
  };
  return { adapter, sent, marked, cleared };
}

const src: SessionSource = { platform: 'feishu', chatId: 'oc_burst', chatType: 'dm', userId: 'ou_burst', userIdAlt: 'un_burst', raw: {} };
const evt = (text: string, messageId: string): MessageEvent => ({ text, messageId, source: src });

let agentId: string;
let restoreFactory: (() => void) | undefined;

async function wireGateway(adapter: PlatformAdapter) {
  const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
  const { PairingManager } = await import('../../electron/main/platform/pairing');
  const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
  const { registerChannelSender } = await import('../../electron/main/platform/outbound');
  registerChannelSender('feishu', (chatId, text) => adapter.send(chatId, text));
  return createPlatformGateway(adapter, {
    pairing: new PairingManager({ now: () => Date.now() }),
    loadWhitelist,
    addToWhitelist,
    resolveRemoteAgentId,
  });
}

async function convKey(): Promise<string> {
  const { findConversationBySource } = await import('../../electron/main/conversations/store');
  const { steeringKey } = await import('../../electron/main/agent/steeringQueue');
  const conv = await findConversationBySource(agentId, { platform: 'feishu', chatId: src.chatId });
  return steeringKey(agentId, conv!.id);
}

beforeAll(async () => {
  runCaptureSpy.mockResolvedValue({ kind: 'ok', opsApplied: 0, opsFailed: 0, coveredUntil: Number.MAX_SAFE_INTEGER });
  await fs.mkdir(ORU_DIR, { recursive: true });
  const { setTasksGateway } = await import('../../electron/main/agent/tasksGateway');
  const { listTasksForConversation, markAnnounced, getLastProgress, getQuestions } = await import('../../electron/main/tasks/store');
  setTasksGateway({ listTasksForConversation, markAnnounced, getLastProgress, getQuestions });
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
  const { saveWhitelist, setRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
  await saveWhitelist([{ id: 'un_burst' }]);
  await setRemoteAgentId(agentId);
  const { updateSettings } = await import('../../electron/main/projects/store');
  await updateSettings({ language: 'zh' });
});

afterEach(async () => {
  const { unregisterChannelSender } = await import('../../electron/main/platform/outbound');
  unregisterChannelSender('feishu');
  // 等本对话的准入闸释放（回合 fire-and-forget），否则下一用例被判忙入队。
  const { steeringQueue } = await import('../../electron/main/agent/steeringQueue');
  const key = await convKey();
  await vi.waitFor(() => expect(steeringQueue.isRunning(key)).toBe(false));
});

afterAll(async () => {
  restoreFactory?.();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('飞书连发合并（S1）端到端', () => {
  it('窗口内连发 3 条：在飞无产出回合被撤起重跑——一个回合、历史 3 条、表情全清、回发一次', async () => {
    const { backend, calls, waitFinalParked, releaseAll } = makeHangBackend('合并后的回复');
    const { __setBackendFactoryForTest } = await import('../../electron/main/agent/backends/factory');
    restoreFactory = __setBackendFactoryForTest(async () => backend);
    const { adapter, sent, marked, cleared } = makeFakeAdapter();
    const gw = await wireGateway(adapter);

    // 第 1 条乐观起回合（桩 backend 挂住、零产出）
    await gw.handleMessage(evt('在', 'om_1'));
    await vi.waitFor(() => expect(calls.length).toBe(1));

    // 窗口内连发第 2、3 条 → 各自判「干净」→ 撤起重跑（重起链上被撤回合可能已注册控制器、
    // 也可能还在串联段被 assertTurnOwned 打住——两种分支都合法，断言对二者同时成立）
    await gw.handleMessage(evt('吗', 'om_2'));
    await vi.waitFor(() => expect(calls[0].abortController.signal.aborted).toBe(true));
    await gw.handleMessage(evt('帮我查个东西', 'om_3'));
    const { steeringQueue } = await import('../../electron/main/agent/steeringQueue');
    const key = await convKey();
    await vi.waitFor(() => expect(steeringQueue.runToken(key)).toBe(3)); // 两次撤起：token 1→2→3
    await waitFinalParked(); // 终回合已进 runChat 挂起（此前被撤的全已 abort）

    // 放行终回合（中间回合已被 abort，放行对它们是 no-op）
    releaseAll();
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].chatId).toBe('oc_burst');
    expect(sent[0].content).toContain('合并后的回复');

    // 终回合（最后一次 LLM 调用）的历史带全部 3 条；此前每次调用都被撤起杀掉
    const final = calls.at(-1)!;
    for (const c of calls.slice(0, -1)) expect(c.abortController.signal.aborted).toBe(true);
    const texts = (final.history ?? []).filter((m) => m.role === 'user').map((m) => m.text);
    expect(texts).toEqual(['在', '吗', '帮我查个东西']);

    // 消息分条（永不拼接）：历史 3 条 user + 1 条 assistant
    const { findConversationBySource, readHistory } = await import('../../electron/main/conversations/store');
    const conv = await findConversationBySource(agentId, { platform: 'feishu', chatId: src.chatId });
    const history = await readHistory(agentId, conv!.id);
    expect(history.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['在', '吗', '帮我查个东西']);
    expect(history.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['合并后的回复']);

    // 表情逐条清（被撤回合的 origins 随 custody 过户进重起回合，无悬挂）
    expect(marked.sort()).toEqual(['om_1', 'om_2', 'om_3']);
    expect(cleared.sort()).toEqual(['om_1', 'om_2', 'om_3']);
  });

  it('有产出后第 2 条走现状（不撤）：在飞回合不被杀，排队项回合末合并续跑——等待项不丢（teardown 语义）', async () => {
    // 桩 backend：首次调用先吐一个 delta（有产出）再挂住；后续调用直接出文本。
    let releaseFirst: () => void = () => {};
    let firstDeltaConsumed = false;
    const calls: ConversationInput[] = [];
    const backend: AgentBackend = {
      backendType: 'claude-code',
      toolProtocol: 'sdk-mcp',
      runConversation: (input) => {
        calls.push(input);
        const isFirst = calls.length === 1;
        return {
          events: (async function* () {
            if (isFirst) {
              yield { type: 'assistant_text' as const, text: '前半截' };
              // 消费端处理完这条 delta（打标「有产出」）后才会来拉下一事件——flag 此刻必已打
              firstDeltaConsumed = true;
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
                input.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
              });
              yield { type: 'result' as const, resultText: '前半截+后半截', isError: false };
              return;
            }
            yield { type: 'result' as const, resultText: '第二条排队后的回复', isError: false };
          })(),
        };
      },
      runOneShot: async () => ({ text: 'unused' }),
      registerTool: () => {},
      unregisterTool: () => {},
      isReady: async () => ({ ok: true, hint: 'mock' }),
    } satisfies AgentBackend;
    const { __setBackendFactoryForTest } = await import('../../electron/main/agent/backends/factory');
    restoreFactory = __setBackendFactoryForTest(async () => backend);
    const { adapter, sent, cleared } = makeFakeAdapter();
    const gw = await wireGateway(adapter);

    await gw.handleMessage(evt('先说一句', 'om_a'));
    await vi.waitFor(() => expect(firstDeltaConsumed).toBe(true)); // 有产出已打标
    await gw.handleMessage(evt('再补一句', 'om_b'));
    // 不撤：在飞回合不被杀、第 2 条入队（队列裁决读打标判不可撤）
    const { steeringQueue } = await import('../../electron/main/agent/steeringQueue');
    const key = await convKey();
    expect(calls[0].abortController.signal.aborted).toBe(false);
    expect(steeringQueue.pendingUserCount(key)).toBe(1);
    // 释放在飞回合 → 回合末合并续跑第 2 条（排队等待的消息不随生命周期蒸发）
    releaseFirst();

    await vi.waitFor(() => expect(sent.length).toBe(2));
    expect(sent[0].content).toContain('前半截');
    expect(sent[1].content).toContain('第二条排队后的回复');
    expect(calls.length).toBe(2);
    expect(calls[0].abortController.signal.aborted).toBe(false);

    const { findConversationBySource, readHistory } = await import('../../electron/main/conversations/store');
    const conv = await findConversationBySource(agentId, { platform: 'feishu', chatId: src.chatId });
    const history = await readHistory(agentId, conv!.id);
    // 用例共享同一对话（同 sessionSource），断言尾部两条（前一用例的连发 3 条也在历史里）
    const userTexts = history.filter((m) => m.role === 'user').map((m) => m.text);
    expect(userTexts.slice(-2)).toEqual(['先说一句', '再补一句']);
    expect(cleared.sort()).toEqual(['om_a', 'om_b']);
  });
});
