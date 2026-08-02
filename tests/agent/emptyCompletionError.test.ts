/**
 * 空产出回合按「出错」形态落盘（PM 拍板 2026-07-26）。
 *
 * 背景：模型对某些请求「HTTP 200 但正文为空」（reasoning-only / 空回复，hy3 前科）。此前
 * runChatAndPersist 把空文本当正常完成落盘——UI 不渲染空文本 → 用户零感知；且这条隐形
 * 「正常完成」消息毒化前端 retryLast 的分流（误走重发、复制旧 user 消息）。
 *
 * 契约：正文与工具调用双零的「成功」= 出错——落盘 assistant 消息带 error{retryable:true}
 * （重启后红条仍在、retryLast 走就地重生成）、emit chat.error、TurnOutcome='error'。
 * sawReasoning（模型思考过但没给正文）与纯空两种文案区分，给用户「模型抽风 vs 没响应」的判断依据。
 *
 * ORU_DIR 范式 + __setBackendFactoryForTest 注入（复用 runnerHttpTailUserTurn 手法）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';
import type { ServerEventPayload } from '@shared/protocol';

const ORU_DIR = join(tmpdir(), `oru-test-empty-completion-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

// 只替换 isConversationBusy 一个导出（runChat 走真身）：空回合重发前后各有一次忙态重检，
// 那是本改动里唯一的承重并发判断，靠它模拟「退避期间用户发了新消息、新一轮已起跑」。
// busyFromCall = Infinity 时恒不忙，其余用例不受影响。
const { busyProbe } = vi.hoisted(() => ({ busyProbe: { calls: 0, busyFromCall: Infinity } }));
vi.mock('../../electron/main/agent/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/agent/runner')>();
  return {
    ...actual,
    isConversationBusy: () => {
      busyProbe.calls += 1;
      return busyProbe.calls >= busyProbe.busyFromCall;
    },
  } satisfies typeof actual;
});

/** stub 行为控制：下一轮 result 事件的内容 */
type StubResult = { resultText: string; sawReasoning?: boolean; toolUse?: boolean };
let nextResult: StubResult = { resultText: '' };
/** 按次数给不同结果（空回合重试用）——排空后回落 nextResult */
let queuedResults: StubResult[] = [];
/** backend 被真正跑起来的次数——重试用例据它数「重发了几次」 */
let runCalls = 0;
let stubBackendType: AgentBackend['backendType'] = 'openai-compatible';

function makeBackend(): AgentBackend {
  return {
    backendType: stubBackendType,
    toolProtocol: 'openai-fc',
    runConversation: (_input: ConversationInput) => {
      runCalls += 1;
      const r = queuedResults.shift() ?? nextResult;
      return {
        events: (async function* () {
          if (r.toolUse) {
            yield { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} } as never;
            yield { type: 'tool_result', toolUseId: 'tu1', isError: false, content: 'ok' } as never;
          }
          yield {
            type: 'result',
            resultText: r.resultText,
            isError: false,
            ...(r.sawReasoning !== undefined ? { sawReasoning: r.sawReasoning } : {}),
          } as never;
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
let restoreBackoff: () => void;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  // 退避缩到毫秒级：重试逻辑本身与时长无关，用例不必替真实退避干等
  const { __setEmptyRetryBackoffForTest } = await import('../../electron/main/ws/runChatAndPersist');
  restoreBackoff = __setEmptyRetryBackoffForTest([1, 1]);
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
  restoreBackoff();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  nextResult = { resultText: '' };
  queuedResults = [];
  runCalls = 0;
  stubBackendType = 'openai-compatible';
  busyProbe.calls = 0;
  busyProbe.busyFromCall = Infinity;
});

async function runTurn(userText: string) {
  const { getAgent } = await import('../../electron/main/agent/store/agents');
  const { createConversation, appendMessage, readHistory } = await import(
    '../../electron/main/conversations/store'
  );
  const { newMessageId } = await import('@shared/ids');
  const { runChatAndPersist } = await import('../../electron/main/ws/runChatAndPersist');
  const agent = await getAgent(agentId);
  const conversation = await createConversation({ agentId, title: '空产出测试', kind: 'sub' });
  await appendMessage(agentId, conversation.id, {
    id: newMessageId(),
    conversationId: conversation.id,
    role: 'user',
    text: userText,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  });
  const emitted: ServerEventPayload[] = [];
  const messageId = newMessageId();
  const callbacks = { assistantPersisted: 0, interruptedPersisted: 0 };
  const outcome = await runChatAndPersist({
    agent,
    conversation,
    messageId,
    userText,
    emit: (ev) => emitted.push(ev),
    onSdkSessionId: async () => {},
    onProposal: async () => {},
    onAssistantPersisted: async () => {
      callbacks.assistantPersisted += 1;
    },
    onInterruptedPersisted: async () => {
      callbacks.interruptedPersisted += 1;
    },
  });
  const history = await readHistory(agentId, conversation.id);
  return { outcome, emitted, history, messageId, callbacks };
}

describe('空产出回合按出错形态落盘', () => {
  it('零文本零工具 → 落盘带 error{retryable:true}、outcome=error、emit chat.error', async () => {
    nextResult = { resultText: '' };
    const { outcome, emitted, history } = await runTurn('讲个故事');

    expect(outcome).toBe('error');
    const tail = history[history.length - 1];
    expect(tail.role).toBe('assistant');
    expect(tail.error).toBeDefined();
    expect(tail.error!.retryable).toBe(true);
    expect(tail.error!.message.length).toBeGreaterThan(0);
    const chatError = emitted.find((e) => e.type === 'chat.error');
    expect(chatError).toBeDefined();
  });

  it('纯空白文本（只有空格换行）同样判空', async () => {
    nextResult = { resultText: '  \n ' };
    const { outcome, history } = await runTurn('讲个故事');
    expect(outcome).toBe('error');
    expect(history[history.length - 1].error).toBeDefined();
  });

  it('sawReasoning=true → 文案区分「思考了但没给出回答」', async () => {
    nextResult = { resultText: '', sawReasoning: true };
    const { history: withReasoning } = await runTurn('讲个故事');
    nextResult = { resultText: '' };
    const { history: withoutReasoning } = await runTurn('讲个故事');

    const msgA = withReasoning[withReasoning.length - 1].error!.message;
    const msgB = withoutReasoning[withoutReasoning.length - 1].error!.message;
    expect(msgA).not.toBe(msgB); // 两种白卷文案不同——给用户「模型想过没答 vs 压根没响应」的判断依据
  });

  it('空产出不走 onAssistantPersisted（渠道回发/回合副作用不吃空回合），列表同步走 onInterruptedPersisted', async () => {
    nextResult = { resultText: '' };
    const { callbacks } = await runTurn('讲个故事');
    // onAssistantPersisted 承载「完整回合」副作用（渠道把 msg.text 回发飞书/Discord 等）——
    // 空回合走它会把空文本发出去，且破坏 mainTurnAssembly「outcome!=='ok' 走不到它」的不变量
    expect(callbacks.assistantPersisted).toBe(0);
    expect(callbacks.interruptedPersisted).toBe(1); // 落盘顶高 updatedAt，列表同步不能丢
  });

  it('有正文 → 正常完成，无 error、outcome=ok', async () => {
    nextResult = { resultText: '从前有座山' };
    const { outcome, history } = await runTurn('讲个故事');
    expect(outcome).toBe('ok');
    const tail = history[history.length - 1];
    expect(tail.text).toBe('从前有座山');
    expect(tail.error).toBeUndefined();
  });

  it('零文本但有工具调用 → 正常完成（模型只干活不说话是合法回合）', async () => {
    nextResult = { resultText: '', toolUse: true };
    const { outcome, history } = await runTurn('读一下文件');
    expect(outcome).toBe('ok');
    expect(history[history.length - 1].error).toBeUndefined();
  });
});

// 回合层自动重试。真实会话 cnv_TymI7oJum2 里 openai-compatible 后端出现 7 次空回合，最长一次
// 空转 549 秒才吐出空白，用户只能手打「继续」——两个后端的流层重试都够不着这一形态（流正常开、
// 正常关、内容为空），只有回合层判得出来。
describe('空回合自动重试', () => {
  it('第一次空、第二次有正文 → 自动重发接住，落盘正文、outcome=ok、期间发过 chat.retrying', async () => {
    queuedResults = [{ resultText: '' }, { resultText: '这次答上来了' }];
    const { outcome, history, emitted } = await runTurn('讲个故事');

    expect(runCalls).toBe(2);
    expect(outcome).toBe('ok');
    const tail = history[history.length - 1];
    expect(tail.text).toBe('这次答上来了');
    expect(tail.error).toBeUndefined();
    // 重试期间必须有可见提示，否则用户面对的是一段无解释的静默
    const retrying = emitted.filter((e) => e.type === 'chat.retrying');
    expect(retrying).toHaveLength(1);
    expect(retrying[0]).toMatchObject({ attempt: 1, maxRetries: 2 });
  });

  it('连续空到底 → 重发有上限（共跑 3 次），最终仍如实落成空产出出错', async () => {
    nextResult = { resultText: '' };
    const { outcome, history } = await runTurn('讲个故事');

    expect(runCalls).toBe(1 + 2); // 首发 + EMPTY_RETRY_MAX 次重发，不无限重试
    expect(outcome).toBe('error');
    expect(history[history.length - 1].error!.retryable).toBe(true);
  });

  it('托管后端（claude-code）不重发——SDK 调 API 前就把 prompt 落进了 session，原样重发会写重两条', async () => {
    stubBackendType = 'claude-code';
    nextResult = { resultText: '' };
    const { outcome, emitted } = await runTurn('讲个故事');

    expect(runCalls).toBe(1);
    expect(emitted.some((e) => e.type === 'chat.retrying')).toBe(false);
    expect(outcome).toBe('error');
  });

  it('有正文的回合不触发重发（重试口径只认双零）', async () => {
    nextResult = { resultText: '从前有座山' };
    await runTurn('讲个故事');
    expect(runCalls).toBe(1);
  });

  // 并发护栏：退避期间本对话不再占着 abort 槽位，用户此时发新消息就会另起一轮。
  // 第 2 次忙态重检（退避之后、重发之前）必须挡住我们去和新一轮抢。
  it('退避期间用户已开新一轮 → 收手不重发，本轮如实落成空产出', async () => {
    busyProbe.busyFromCall = 2; // 退避前那次不忙、退避后那次忙
    nextResult = { resultText: '' };
    const { outcome, emitted, history } = await runTurn('讲个故事');

    expect(runCalls).toBe(1); // 没抢
    expect(emitted.some((e) => e.type === 'chat.started')).toBe(false); // 也没点亮按不动的停止按钮
    expect(emitted.some((e) => e.type === 'chat.retrying')).toBe(false);
    expect(outcome).toBe('error');
    expect(history[history.length - 1].error).toBeDefined();
  });

  it('退避之前就已经忙 → 连退避都不进', async () => {
    busyProbe.busyFromCall = 1;
    nextResult = { resultText: '' };
    const { outcome } = await runTurn('讲个故事');
    expect(runCalls).toBe(1);
    expect(outcome).toBe('error');
  });

  // S1 review · C1 回归：退避期间闸被连发撤起翻新（isTurnOwned 翻 false）——撤起的 abort 杀不到
  // 退避中的回合（控制器未注册），不重检归属的话它会「复活」重跑、把空结果落成错误卡甚至与
  // 新一轮并发抢闸。归属丢失必须按 aborted 收：不重发、不落盘、不发 chat.error。
  it('退避期间归属被夺（连发撤起）→ 不重发、按 aborted 收、不落错误卡', async () => {
    nextResult = { resultText: '' };
    const { getAgent } = await import('../../electron/main/agent/store/agents');
    const { createConversation, appendMessage, readHistory } = await import(
      '../../electron/main/conversations/store'
    );
    const { newMessageId } = await import('@shared/ids');
    const { runChatAndPersist } = await import('../../electron/main/ws/runChatAndPersist');
    const agent = await getAgent(agentId);
    const conversation = await createConversation({ agentId, title: 'C1 回归', kind: 'sub' });
    await appendMessage(agentId, conversation.id, {
      id: newMessageId(),
      conversationId: conversation.id,
      role: 'user',
      text: '讲个故事',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    });
    const emitted: ServerEventPayload[] = [];
    let owned = true;
    const outcome = await runChatAndPersist({
      agent,
      conversation,
      messageId: newMessageId(),
      userText: '讲个故事',
      emit: (ev) => {
        emitted.push(ev);
        // 首次空结果落定、进入退避后夺闸（模拟 supersede 翻新 token）
        if (ev.type === 'chat.done') owned = false;
      },
      onSdkSessionId: async () => {},
      onProposal: async () => {},
      isTurnOwned: () => owned,
    });

    expect(runCalls).toBe(1); // 不重发——退避醒来归属已失，收手
    expect(outcome).toBe('aborted');
    const history = await readHistory(agentId, conversation.id);
    expect(history.filter((m) => m.role === 'assistant')).toHaveLength(0); // 不落错误卡
    expect(emitted.some((e) => e.type === 'chat.error')).toBe(false); // 不冒红条
    expect(emitted.some((e) => e.type === 'chat.retrying')).toBe(false);
  });

  // C1 常见分支（真机目验抓到）：退避醒来时新一轮已注册控制器（busy=true）——busy 先命中 break
  // 会把空结果交出去落 emptyError 错误卡。归属复核必须先于忙态：owned=false 时一律按 aborted 收。
  it('退避醒来新一轮已占位（busy）但归属已失 → 仍按 aborted 收，不落错误卡', async () => {
    busyProbe.busyFromCall = 2; // 退避后那次忙态重检=true（新一轮已起跑）
    nextResult = { resultText: '' };
    const { getAgent } = await import('../../electron/main/agent/store/agents');
    const { createConversation, appendMessage, readHistory } = await import(
      '../../electron/main/conversations/store'
    );
    const { newMessageId } = await import('@shared/ids');
    const { runChatAndPersist } = await import('../../electron/main/ws/runChatAndPersist');
    const agent = await getAgent(agentId);
    const conversation = await createConversation({ agentId, title: 'C1 常见分支', kind: 'sub' });
    await appendMessage(agentId, conversation.id, {
      id: newMessageId(),
      conversationId: conversation.id,
      role: 'user',
      text: '讲个故事',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    });
    const emitted: ServerEventPayload[] = [];
    let owned = true;
    const outcome = await runChatAndPersist({
      agent,
      conversation,
      messageId: newMessageId(),
      userText: '讲个故事',
      emit: (ev) => {
        emitted.push(ev);
        if (ev.type === 'chat.done') owned = false; // 首次空结果落定、进入退避后夺闸
      },
      onSdkSessionId: async () => {},
      onProposal: async () => {},
      isTurnOwned: () => owned,
    });

    expect(runCalls).toBe(1);
    expect(outcome).toBe('aborted'); // 不是 error——空结果不落 emptyError
    const history = await readHistory(agentId, conversation.id);
    expect(history.filter((m) => m.role === 'assistant')).toHaveLength(0);
    expect(emitted.some((e) => e.type === 'chat.error')).toBe(false);
  });

  // C1 真机变体（2026-08-01 目验抓到）：托管后端空回合不重试（mayRetryEmptyTurn=false），
  // 被撤回合的 LLM 调用「秒回空结果」完成在撤起之前——空结果走到 emptyError 落卡点时必须
  // 再过一次归属末检，否则撤起在飞书/桌面留下「模型没有返回内容」垃圾卡（当时真机落了两条）。
  it('托管后端秒回空 + 归属已失（撤起）→ 空结果不落卡，按 aborted 收', async () => {
    stubBackendType = 'claude-code'; // 空回合不重试：直奔 emptyError 落卡点
    nextResult = { resultText: '' };
    const { getAgent } = await import('../../electron/main/agent/store/agents');
    const { createConversation, appendMessage, readHistory } = await import(
      '../../electron/main/conversations/store'
    );
    const { newMessageId } = await import('@shared/ids');
    const { runChatAndPersist } = await import('../../electron/main/ws/runChatAndPersist');
    const agent = await getAgent(agentId);
    const conversation = await createConversation({ agentId, title: 'C1 真机变体', kind: 'sub' });
    await appendMessage(agentId, conversation.id, {
      id: newMessageId(),
      conversationId: conversation.id,
      role: 'user',
      text: '在',
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    });
    const emitted: ServerEventPayload[] = [];
    let owned = true;
    const outcome = await runChatAndPersist({
      agent,
      conversation,
      messageId: newMessageId(),
      userText: '在',
      emit: (ev) => {
        emitted.push(ev);
        if (ev.type === 'chat.done') owned = false; // 空结果落定后被撤起（闸易主）
      },
      onSdkSessionId: async () => {},
      onProposal: async () => {},
      isTurnOwned: () => owned,
    });

    expect(runCalls).toBe(1); // 不重试（托管后端口径不变）
    expect(outcome).toBe('aborted');
    const history = await readHistory(agentId, conversation.id);
    expect(history.filter((m) => m.role === 'assistant')).toHaveLength(0); // 空卡没落
    expect(emitted.some((e) => e.type === 'chat.error')).toBe(false);
  });
});
