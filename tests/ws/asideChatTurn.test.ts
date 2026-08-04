/**
 * chat 管线的 aside 分支 + aside.addReferent —— router 接线层（T8）：
 *
 * - chat.send 到 kind:'aside' 对话：runChatAndPersist 收到 asideMode:true、
 *   restrictToolsTo=白名单、extraToolDenylist=注册表全量−白名单、extraStableSystemPrompt
 *   为 aside 行为规则；subagentSupport / askUserChoice / onProposal 全部缺席（纵深兜底）
 * - chat.send 到普通对话：上述参数与改动前一致（关键回归面——三回调在场、aside 字段全缺席）
 * - aside.addReferent：忙锁 → 标准错误包带 AGENT_BUSY、指代卡不落盘、不起轮；
 *   正常路径 → 响应 aside.addReferent.result 带 hydrate 后的指代卡（渲染端灌桶用）、
 *   指代卡（kind/payload/附件）落盘、以卡 text 为 userText 跑正常回合
 * - addReferent 的指代卡作为正常回合在 ClaudeCode 路径带图入模（EnginePromptBlock 含 image）
 *
 * ORU_DIR 范式：顶层先设 env，store/router 全部动态 import。runChatAndPersist 与
 * runner（忙锁）mock 掉——本文件测的是 router 的接线，不起真流式；engine mock 给
 * ClaudeCode 带图断言（satisfies 真接口）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerEventPayload } from '@shared/protocol';
import type { AgentTool } from '@shared/agent/backend';
import type { RunChatAndPersistArgs } from '../../electron/main/ws/runChatAndPersist';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';

const ORU_DIR = join(tmpdir(), `oru-test-aside-chat-turn-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const { runChatAndPersistMock, busyState, engineRunCalls } = vi.hoisted(() => ({
  runChatAndPersistMock: vi.fn(async (_args: unknown) => undefined),
  busyState: { busy: false },
  engineRunCalls: [] as EngineRunInput[],
}));

vi.mock('../../electron/main/ws/runChatAndPersist', () => ({
  runChatAndPersist: runChatAndPersistMock,
}) satisfies Pick<typeof import('../../electron/main/ws/runChatAndPersist'), 'runChatAndPersist'>);

// 忙锁可控：addReferent 的 AGENT_BUSY 分支靠它驱动（真锁要起真流式轮，测试设施起不了）
vi.mock('../../electron/main/agent/runner', () => ({
  abortConversation: vi.fn(() => false),
  isConversationBusy: () => busyState.busy,
  runChat: vi.fn(),
}) satisfies Pick<
  typeof import('../../electron/main/agent/runner'),
  'abortConversation' | 'isConversationBusy' | 'runChat'
>);

// 后端就绪预检（chat.ts 起回合前置）必须 stub 掉——它走真实 backend.isReady()，依赖本机登录态，
// 本地(已登录)过、CI(无鉴权)挂。本文件测 router 的 aside 接线，就绪检查不在测面，固定 ok 即可。
vi.mock('../../electron/main/agent/backends/readiness', () => ({
  checkBackendReady: vi.fn(async () => ({ ok: true, hint: '' })),
}) satisfies Pick<typeof import('../../electron/main/agent/backends/readiness'), 'checkBackendReady'>);

// ClaudeCode 带图断言用 engine mock（同 tests/agent/restrictToolsTo.test.ts 范式）
vi.mock('../../electron/main/engine', () => {
  const engine = {
    run: (input: EngineRunInput): EngineRunHandle => {
      engineRunCalls.push(input);
      return {
        events: (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'result', resultText: 'ok', isError: false };
        })(),
      };
    },
    mcp: {
      createServer: () => ({}),
      defineTool: (name: string) => ({ name }),
    },
  } satisfies CodeExecutionEngine;
  return { engine };
});

// 8 字节 PNG magic——过 saveAttachments 校验
const PNG_BASE64 = 'iVBORw0KGgo=';

const REFERENT = {
  type: 'message',
  label: '一条配色消息',
  messageId: 'msg-target',
  text: '这页的配色有点闷',
  context: '上一条：配色草稿；下一条：好的我调亮',
} as const;

/** 最近一次 runChatAndPersist 收到的入参 */
function lastTurnArgs(): RunChatAndPersistArgs {
  expect(runChatAndPersistMock).toHaveBeenCalled();
  return runChatAndPersistMock.mock.calls.at(-1)![0] as RunChatAndPersistArgs;
}

function collector() {
  const replies: ServerEventPayload[] = [];
  const broadcasts: ServerEventPayload[] = [];
  return {
    replies,
    broadcasts,
    reply: (_reqId: string, ev: ServerEventPayload) => replies.push(ev),
    broadcast: (ev: ServerEventPayload) => broadcasts.push(ev),
  };
}

let agentId: string;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
  // 注册表：一个白名单内 + 两个白名单外——denylist 断言要可判定
  const { registerTool } = await import('../../electron/main/agent/backends/factory');
  const makeTool = (name: string) =>
    ({
      name,
      description: `测试工具 ${name}`,
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ text: 'ok' }),
    }) satisfies AgentTool;
  registerTool(makeTool('read_file'), ['twinMain']);
  registerTool(makeTool('write_file'), ['twinMain']);
  registerTool(makeTool('propose_action'), ['twinMain']);
});

afterAll(async () => {
  const { __clearToolRegistryForTest } = await import(
    '../../electron/main/agent/backends/factory'
  );
  __clearToolRegistryForTest();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  runChatAndPersistMock.mockClear();
  busyState.busy = false;
  engineRunCalls.length = 0;
});

describe('chat.send 的 aside 分支', () => {
  it('aside 对话：asideMode + 白名单 + denylist 兜底 + aside 规则；三个动手回调全缺席', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation } = await import('../../electron/main/conversations/store');
    const { ASIDE_CHAT_RULES } = await import('../../electron/main/ws/aside/comment');
    const { ASIDE_TOOL_WHITELIST } = await import('../../electron/main/ws/aside/toolWhitelist');
    const conv = await createConversation({ agentId, title: '短聊', kind: 'aside' });

    const c = collector();
    await route(
      { type: 'chat.send', reqId: 'r1', agentId, conversationId: conv.id, text: '这块怎么样' },
      c.reply,
      c.broadcast,
    );

    expect(c.replies).toEqual([{ type: 'ack' }]);
    const args = lastTurnArgs();
    // systemContext 裁剪的管线接线层：runner 真收到 asideMode（构造层由 T5 测试覆盖）
    expect(args.asideMode).toBe(true);
    expect(args.restrictToolsTo).toEqual(ASIDE_TOOL_WHITELIST);
    // 兜底 denylist = 注册表全量 − 白名单（read_file 在白名单内，不进 denylist）
    expect(args.extraToolDenylist?.sort()).toEqual(['propose_action', 'write_file']);
    // aside 行为规则注入（特征句：身份 + 不动手 + ↗ 引导）
    expect(args.extraStableSystemPrompt).toBe(ASIDE_CHAT_RULES);
    expect(args.extraStableSystemPrompt).toContain('随手评点');
    expect(args.extraStableSystemPrompt).toContain('不动手改东西');
    expect(args.extraStableSystemPrompt).toContain('↗');
    // 三类动手面的纵深兜底：回调全部缺席
    expect(args.subagentSupport).toBeUndefined();
    expect(args.askUserChoice).toBeUndefined();
    expect(args.onProposal).toBeUndefined();
    expect(args.userText).toBe('这块怎么样');
  });

  it('普通对话（sub）无回归：三回调在场、aside 字段全缺席', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createSubConversation } = await import('../../electron/main/conversations/store');
    const conv = await createSubConversation(agentId, '普通对话');

    const c = collector();
    await route(
      { type: 'chat.send', reqId: 'r1', agentId, conversationId: conv.id, text: '普通消息' },
      c.reply,
      c.broadcast,
    );

    const args = lastTurnArgs();
    expect(args.asideMode).toBeUndefined();
    expect(args.restrictToolsTo).toBeUndefined();
    expect(args.extraToolDenylist).toBeUndefined();
    expect(args.extraStableSystemPrompt).toBeUndefined();
    expect(typeof args.onProposal).toBe('function');
    expect(typeof args.askUserChoice).toBe('function');
    expect(args.subagentSupport).toBeDefined();
    expect(typeof args.subagentSupport!.broadcastChip).toBe('function');
    expect(typeof args.subagentSupport!.persistChip).toBe('function');
  });
});

describe('route(aside.addReferent)', () => {
  it('正常路径：result 带 hydrate 后的卡 + chat.started；指代卡落盘（kind/payload/附件）；以卡 text 为 userText 跑 aside 回合', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation, readHistory } = await import(
      '../../electron/main/conversations/store'
    );
    const conv = await createConversation({ agentId, title: '短聊', kind: 'aside' });

    const c = collector();
    await route(
      {
        type: 'aside.addReferent',
        reqId: 'r1',
        agentId,
        conversationId: conv.id,
        referent: REFERENT,
        screenshot: PNG_BASE64,
      },
      c.reply,
      c.broadcast,
    );

    expect(c.broadcasts.filter((b) => b.type === 'chat.started')).toHaveLength(1);

    // 指代卡落盘字段（vision 闸默认开：未分配 twinMain 模型走 OAuth fallback = 支持视觉）
    const history = await readHistory(agentId, conv.id);
    expect(history).toHaveLength(1);
    const card = history[0];
    expect(card.role).toBe('user');
    expect(card.kind).toBe('aside-referent');
    expect(card.asideReferent).toEqual(REFERENT);
    expect(card.attachments).toHaveLength(1);
    expect(card.attachments![0].relPath).toBe(`${conv.id}-images/${card.id}-1.png`);

    // 响应是 result 事件、带 hydrate 后的同一张卡（渲染端拿它灌桶——浮层 / promote 后可见）
    expect(c.replies).toHaveLength(1);
    const res = c.replies[0];
    expect(res.type).toBe('aside.addReferent.result');
    if (res.type !== 'aside.addReferent.result') throw new Error('unreachable');
    expect(res.message.id).toBe(card.id);
    expect(res.message.kind).toBe('aside-referent');
    expect(res.message.attachments![0].displayUrl).toMatch(/^oru-conv-img:\/\//);

    // 以指代卡为 user 消息跑一轮正常回合，且带全套 aside 分支差异
    const args = lastTurnArgs();
    expect(args.userText).toBe(card.text);
    expect(args.userText).toContain('这页的配色有点闷');
    expect(args.asideMode).toBe(true);
    expect(args.subagentSupport).toBeUndefined();
  });

  it('撞上进行中的流式轮：AGENT_BUSY 标准错误包原样回；指代卡不落盘、不起轮（队列驻渲染端）', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation, readHistory } = await import(
      '../../electron/main/conversations/store'
    );
    const conv = await createConversation({ agentId, title: '忙场', kind: 'aside' });

    busyState.busy = true;
    const c = collector();
    await route(
      {
        type: 'aside.addReferent',
        reqId: 'r1',
        agentId,
        conversationId: conv.id,
        referent: REFERENT,
      },
      c.reply,
      c.broadcast,
    );

    expect(c.replies).toHaveLength(1);
    const err = c.replies[0];
    expect(err.type).toBe('error');
    if (err.type !== 'error') throw new Error('unreachable');
    expect(err.code).toBe('AGENT_BUSY');
    // 忙时绝不落卡——先落盘会让 JSONL 出现「指代卡 → 上一问的回复」的错位历史
    expect(await readHistory(agentId, conv.id)).toHaveLength(0);
    expect(runChatAndPersistMock).not.toHaveBeenCalled();
    expect(c.broadcasts).toHaveLength(0);
  });

  it('vision 闸跟评点模型（二期 §3）：评点模型非视觉、主模型视觉 → 指代卡不落图', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation, readHistory } = await import(
      '../../electron/main/conversations/store'
    );
    const { updateSettings } = await import('../../electron/main/projects/store');
    // 评点模型 model-nv 不支持视觉；twinMain 配视觉模型——闸若仍挂主模型，本用例假绿
    await updateSettings({
      providers: [
        { id: 'prov-1', type: 'openrouter', label: 'OR', apiKey: 'sk-fake' },
      ],
      models: [
        { id: 'model-v', providerId: 'prov-1', modelId: 'm-v', label: 'm-v', contextWindow: 200000, supportsVision: true },
        { id: 'model-nv', providerId: 'prov-1', modelId: 'm-nv', label: 'm-nv', contextWindow: 200000, supportsVision: false },
      ],
      modelAssignments: {
        twinMain: 'model-v',
        twinBackground: null,
        memoryDream: null,
        subagentCoder: null,
        conversationSummary: null,
        conversationTitle: null,
        twinSubagent: null,
        asideComment: 'model-nv',
      },
    });
    try {
      const conv = await createConversation({ agentId, title: '非视觉评点', kind: 'aside' });
      const c = collector();
      await route(
        {
          type: 'aside.addReferent',
          reqId: 'r1',
          agentId,
          conversationId: conv.id,
          referent: REFERENT,
          screenshot: PNG_BASE64,
        },
        c.reply,
        c.broadcast,
      );
      const history = await readHistory(agentId, conv.id);
      expect(history).toHaveLength(1);
      expect(history[0].attachments).toBeUndefined();
    } finally {
      await updateSettings({
        providers: [],
        models: [],
        modelAssignments: {
          twinMain: null,
          twinBackground: null,
          memoryDream: null,
          subagentCoder: null,
          conversationSummary: null,
          conversationTitle: null,
          twinSubagent: null,
          asideComment: null,
        },
      });
    }
  });

  it('朴素计数（二期 §8）：addReferent 计一次 ⌥ 点；AGENT_BUSY 不计（重发不双算）', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation } = await import('../../electron/main/conversations/store');
    const { flushAsideStats, __resetForTest } = await import(
      '../../electron/main/ws/aside/stats'
    );
    const { getCurrentOwnerId } = await import(
      '../../electron/main/identity/getCurrentOwnerId'
    );
    __resetForTest();
    const conv = await createConversation({ agentId, title: '计数', kind: 'aside' });

    const c = collector();
    await route(
      { type: 'aside.addReferent', reqId: 'r1', agentId, conversationId: conv.id, referent: REFERENT },
      c.reply,
      c.broadcast,
    );
    busyState.busy = true;
    await route(
      { type: 'aside.addReferent', reqId: 'r2', agentId, conversationId: conv.id, referent: REFERENT },
      c.reply,
      c.broadcast,
    );
    await flushAsideStats();

    const statsRaw = await fs.readFile(
      join(ORU_DIR, 'users', getCurrentOwnerId(), 'aside-stats.json'),
      'utf-8',
    );
    const days = JSON.parse(statsRaw) as Record<string, { addReferents: number }>;
    const total = Object.values(days).reduce((s, d) => s + d.addReferents, 0);
    expect(total).toBe(1); // busy 那次被拒，不计
  });

  it('指代卡作为正常回合在 ClaudeCode 路径带图入模（EnginePromptBlock 含 image）', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation, readHistory } = await import(
      '../../electron/main/conversations/store'
    );
    const { ClaudeCodeBackend } = await import(
      '../../electron/main/agent/backends/claudeCode'
    );
    const conv = await createConversation({ agentId, title: '带图轮', kind: 'aside' });

    const c = collector();
    await route(
      {
        type: 'aside.addReferent',
        reqId: 'r1',
        agentId,
        conversationId: conv.id,
        referent: REFERENT,
        screenshot: PNG_BASE64,
      },
      c.reply,
      c.broadcast,
    );
    const history = await readHistory(agentId, conv.id);
    const card = history.at(-1)!;

    // 与 runner 同形态喂 ClaudeCode：history 含指代卡、userMessage 即卡 text（本轮有新 user 消息）
    const backend = new ClaudeCodeBackend('claude-opus-4-8', { supportsVision: true });
    const handle = backend.runConversation({
      agentId,
      conversationId: conv.id,
      userMessage: card.text,
      history,
      cwd: process.cwd(),
      abortController: new AbortController(),
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of handle.events) {
      // 耗尽流，断言在 engine 入参上做
    }

    const input = engineRunCalls.at(-1)!;
    expect(Array.isArray(input.prompt)).toBe(true);
    const blocks = input.prompt as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
    expect(blocks.at(-1)!.type).toBe('text');
  });
});
