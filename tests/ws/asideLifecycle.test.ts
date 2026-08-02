/**
 * aside.list / aside.promote —— router 本体集成版（防线架在 route()，仿 proposalExecuteRoute）：
 * - list：只返回 kind:'aside'（不含 main/sub）、updatedAt 倒序；响应是 aside.list.result
 *   独立事件，绝不发 conv.state（发了就会冲掉渲染端主列表——这是设计的承重约束）
 * - promote：rekind 后 kind='sub' 进主列表；广播 conv.state（mock 广播通道断言）；
 *   源不是 aside 在 handler 层拒绝且不广播；promote 后再 begin 新 aside 互不影响
 * - 并发：promote 与 appendMessage 并发不损坏数据（store 写队列串行化的回归；
 *   真流式轮的并发留给 smoke——测试设施起不了真流式）
 *
 * ORU_DIR 范式：顶层先设 env，router/store 全部动态 import（路径模块 load 时锁 env）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerEventPayload } from '@shared/protocol';

const ORU_DIR = join(tmpdir(), `oru-test-aside-lifecycle-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'local-user';

/** 收集 reply/broadcast 的最小桩——断言事件序列用 */
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

function makeMessage(conversationId: string, text: string) {
  return {
    id: `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    conversationId,
    role: 'user' as const,
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  };
}

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('route(aside.list)', () => {
  it('只返回 aside（不含 sub）、updatedAt 倒序；响应独立事件、绝不发 conv.state', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createSubConversation, createConversation, appendMessage } =
      await import('../../electron/main/conversations/store');
    const agentId = 'agent-aside-list';
    await createSubConversation(agentId, '普通子对话');
    const asideOld = await createConversation({ agentId, title: '先点的', kind: 'aside' });
    const asideNew = await createConversation({ agentId, title: '后点的', kind: 'aside' });
    // 给先建的追加消息刷 updatedAt——倒序断言不依赖创建时间戳恰好不同毫秒
    await appendMessage(agentId, asideOld.id, makeMessage(asideOld.id, '刷 updatedAt'));

    const c = collector();
    await route({ type: 'aside.list', reqId: 'r1', agentId }, c.reply, c.broadcast);

    expect(c.replies).toHaveLength(1);
    const ev = c.replies[0];
    expect(ev.type).toBe('aside.list.result');
    if (ev.type !== 'aside.list.result') throw new Error('unreachable');
    expect(ev.agentId).toBe(agentId);
    expect(ev.conversations.map((x) => x.id)).toEqual([asideOld.id, asideNew.id]);
    expect(ev.conversations.every((x) => x.kind === 'aside')).toBe(true);
    // 承重约束：aside.list 不得借 conv.state（会整体替换渲染端主列表 + 拽走 active）
    expect(c.broadcasts.filter((b) => b.type === 'conv.state')).toHaveLength(0);
  });
});

describe('route(aside.begin)', () => {
  it('vision 闸接线 + 回执形态：twinMain 支持视觉 → 截图落附件并 hydrate displayUrl', async () => {
    const { route } = await import('../../electron/main/ws/router');
    // 行为靠显式设置，不靠"测试环境恰好无分配 → OAuth fallback 恰好支持视觉"的隐性默认
    const { updateSettings } = await import('../../electron/main/projects/store');
    await updateSettings({
      models: [
        {
          id: 'model-vision',
          providerId: 'prov-test',
          modelId: 'test/vision-model',
          label: 'vision 测试模型',
          supportsVision: true,
        },
      ],
      modelAssignments: {
        twinMain: 'model-vision',
        twinBackground: null,
        memoryDream: null,
        subagentCoder: null,
        conversationSummary: null,
        conversationTitle: null,
        twinSubagent: null,
        asideComment: null,
      },
    });
    const agentId = 'agent-begin-route';
    // 8 字节 PNG magic——足以通过 saveAttachments 的 magic-byte 校验
    const PNG_BASE64 = 'iVBORw0KGgo=';

    const c = collector();
    await route(
      {
        type: 'aside.begin',
        reqId: 'r1',
        agentId,
        referent: { type: 'blank', label: '一处空白' },
        screenshot: PNG_BASE64,
        comment: '这儿空得很有性格。',
      },
      c.reply,
      c.broadcast,
    );

    expect(c.replies).toHaveLength(1);
    const ev = c.replies[0];
    expect(ev.type).toBe('aside.begin.result');
    if (ev.type !== 'aside.begin.result') throw new Error('unreachable');
    expect(ev.conversation.kind).toBe('aside');
    expect(ev.conversation.title).toBe('一处空白');
    // 种子顺序固定：指代卡（user）→ 短评（assistant）
    expect(ev.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(ev.messages[0].kind).toBe('aside-referent');
    // vision 闸接线：twinMain 显式配了 supportsVision 模型 → 截图入附件，
    // 且响应出口已 hydrate displayUrl（渲染端缩略图直接可用）
    expect(ev.messages[0].attachments).toHaveLength(1);
    expect(ev.messages[0].attachments?.[0].displayUrl).toMatch(/^oru-conv-img:\/\//);
    // 同 aside.list 的承重约束：begin 也不借 conv.state（aside 不进主列表）
    expect(c.broadcasts.filter((b) => b.type === 'conv.state')).toHaveLength(0);
  });
});

describe('route(aside.promote)', () => {
  it('rekind 后 kind=sub 进主列表；广播 conv.state（先广播后 ack）；JSONL 原地未动', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation, appendMessage, listConversations } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-promote-ok';
    const aside = await createConversation({ agentId, title: '待转正', kind: 'aside' });
    await appendMessage(agentId, aside.id, makeMessage(aside.id, '短聊内容'));
    const jsonlPath = join(ORU_DIR, 'users', OWNER, 'conversations', agentId, `${aside.id}.jsonl`);
    const jsonlBefore = await fs.readFile(jsonlPath, 'utf-8');

    const c = collector();
    await route(
      { type: 'aside.promote', reqId: 'r1', agentId, conversationId: aside.id },
      c.reply,
      c.broadcast,
    );

    expect(c.replies).toEqual([{ type: 'ack' }]);
    // 广播 conv.state 让主列表浮现转正对话
    const convStates = c.broadcasts.filter((b) => b.type === 'conv.state');
    expect(convStates).toHaveLength(1);
    if (convStates[0].type !== 'conv.state') throw new Error('unreachable');
    expect(convStates[0].conversations.some((x) => x.id === aside.id && x.kind === 'sub')).toBe(true);
    // 落盘口径一致；消息 JSONL 逐字节未动（rekind 只动 index）
    const list = await listConversations(agentId);
    expect(list.some((x) => x.id === aside.id && x.kind === 'sub')).toBe(true);
    expect(await fs.readFile(jsonlPath, 'utf-8')).toBe(jsonlBefore);
  });

  it('源不是 aside（sub）→ handler 层拒绝：error 回执、kind 不变、不广播', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createSubConversation, getConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-promote-reject';
    const sub = await createSubConversation(agentId, '普通子对话');

    const c = collector();
    await route(
      { type: 'aside.promote', reqId: 'r1', agentId, conversationId: sub.id },
      c.reply,
      c.broadcast,
    );

    expect(c.replies).toHaveLength(1);
    expect(c.replies[0].type).toBe('error');
    expect((await getConversation(agentId, sub.id)).kind).toBe('sub');
    expect(c.broadcasts).toHaveLength(0);
  });

  it('promote 后再 begin 新 aside 互不影响：归档列表只剩新的，转正的在主列表', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { runAsideBegin } = await import('../../electron/main/ws/aside/begin');
    const { listAsideConversations, listConversations } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-promote-then-begin';
    const referent = { type: 'blank', label: '一处空白' } as const;
    const first = await runAsideBegin({ type: 'aside.begin', agentId, referent }, false);

    const c = collector();
    await route(
      { type: 'aside.promote', reqId: 'r1', agentId, conversationId: first.conversation.id },
      c.reply,
      c.broadcast,
    );
    const second = await runAsideBegin(
      { type: 'aside.begin', agentId, referent, comment: '新的一场' },
      false,
    );

    const asides = await listAsideConversations(agentId);
    expect(asides.map((x) => x.id)).toEqual([second.conversation.id]);
    const main = await listConversations(agentId);
    expect(main.some((x) => x.id === first.conversation.id && x.kind === 'sub')).toBe(true);
    expect(main.some((x) => x.id === second.conversation.id)).toBe(false);
  });

  it('promote 与 appendMessage 并发：两个效果都落地、index.json 不损坏', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation, appendMessage, getConversation, readHistory } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-promote-race';
    const aside = await createConversation({ agentId, title: '并发场', kind: 'aside' });
    const racer = makeMessage(aside.id, '流式轮代表：promote 同时落一条消息');

    const c = collector();
    await Promise.all([
      route(
        { type: 'aside.promote', reqId: 'r1', agentId, conversationId: aside.id },
        c.reply,
        c.broadcast,
      ),
      appendMessage(agentId, aside.id, racer),
    ]);

    // 两个效果都在：kind 已转、消息已落
    expect((await getConversation(agentId, aside.id)).kind).toBe('sub');
    expect((await readHistory(agentId, aside.id)).some((m) => m.id === racer.id)).toBe(true);
    // index.json 仍是合法 JSON 且包含该对话（写队列串行化的直接回归）
    const raw = await fs.readFile(
      join(ORU_DIR, 'users', OWNER, 'conversations', agentId, 'index.json'),
      'utf-8',
    );
    // D5：index.json 为 versioned envelope { version, conversations }；兼容裸数组(v1)。
    const env = JSON.parse(raw);
    const parsed = (Array.isArray(env) ? env : env.conversations) as Array<{ id: string; kind: string }>;
    expect(parsed.some((x) => x.id === aside.id && x.kind === 'sub')).toBe(true);
  });
});
