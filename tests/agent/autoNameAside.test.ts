/**
 * aside 对话自动命名（二期 §5）——专用触发，不动 maybeAutoNameConversation 的 sub 逻辑：
 * - 闸：首条消息是指代卡（kind:'aside-referent'）且 conv.title === 出生 label（卡的
 *   asideReferent.label）。用户已改名 / 已命名过 → 不动；普通对话（无卡）→ 短路。
 * - 先转正后聊的边角：kind 已是 sub、标题仍是出生 label → 照常命名（同一函数判）。
 * - prompt 复用 sub 命名内核，额外带指代卡文本（「就着什么聊的」比只看两句对话起名准）；
 *   disableReasoning: true；conversationTitle 用途路由 + 未配置不命名（同 sub 口径）。
 * - 命名失败静默，不向 chat 流抛。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, OneShotInput } from '@shared/agent/backend';
import type { AsideReferent, Conversation } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-auto-name-aside-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const REFERENT: AsideReferent = {
  type: 'message',
  label: '消息 · “这页配色有点闷”',
  messageId: 'msg-x',
  text: '这页配色有点闷',
  context: '',
};

const oneShotCalls: OneShotInput[] = [];
let oneShotResult = '配色讨论';
let oneShotFail = false;

function makeBackend(): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    runConversation: () => {
      throw new Error('not used');
    },
    runOneShot: async (input: OneShotInput) => {
      oneShotCalls.push(input);
      if (oneShotFail) throw new Error('provider 500');
      return { text: oneShotResult };
    },
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  } satisfies AgentBackend;
}

let agentId: string;
let restoreFactory: () => void;

async function configureTitleModel(assigned: boolean): Promise<void> {
  const { updateSettings } = await import('../../electron/main/projects/store');
  await updateSettings({
    providers: assigned ? [{ id: 'prov-1', type: 'openrouter', label: 'OR', apiKey: 'sk' }] : [],
    models: assigned
      ? [{ id: 'model-t', providerId: 'prov-1', modelId: 'm-t', label: 'm-t', contextWindow: 200000, supportsVision: false }]
      : [],
    modelAssignments: {
      twinMain: null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: null,
      conversationSummary: null,
      conversationTitle: assigned ? 'model-t' : null,
      twinSubagent: null,
      asideComment: null,
    },
  });
}

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
  const { __setBackendFactoryForTest } = await import(
    '../../electron/main/agent/backends/factory'
  );
  restoreFactory = __setBackendFactoryForTest(async () => makeBackend());
  await configureTitleModel(true);
});

afterAll(async () => {
  restoreFactory();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

afterEach(() => {
  oneShotCalls.length = 0;
  oneShotResult = '配色讨论';
  oneShotFail = false;
});

/** 造一个出生形态的 aside 对话：指代卡种子 + 用户开口 + 首轮回复（落盘三条） */
async function makeAsideConv(p?: {
  title?: string;
  kind?: Conversation['kind'];
  withReferentCard?: boolean;
}): Promise<Conversation> {
  const { createConversation, appendMessage } = await import(
    '../../electron/main/conversations/store'
  );
  const { newMessageId } = await import('@shared/ids');
  const conv = await createConversation({
    agentId,
    title: p?.title ?? REFERENT.label,
    kind: p?.kind ?? 'aside',
  });
  const base = { conversationId: conv.id, toolCalls: [], createdAt: Date.now(), done: true };
  if (p?.withReferentCard !== false) {
    await appendMessage(agentId, conv.id, {
      ...base,
      id: newMessageId(),
      role: 'user',
      kind: 'aside-referent',
      asideReferent: REFERENT,
      text: '用户按住 Option 点击了对话里的一条消息。\n消息内容：这页配色有点闷',
    });
  }
  await appendMessage(agentId, conv.id, {
    ...base,
    id: newMessageId(),
    role: 'user',
    text: '你觉得呢',
  });
  await appendMessage(agentId, conv.id, {
    ...base,
    id: newMessageId(),
    role: 'assistant',
    text: '确实闷，亮一档会好',
  });
  return conv;
}

async function runNaming(conversationId: string): Promise<void> {
  const { maybeAutoNameAsideConversation } = await import(
    '../../electron/main/agent/autoNameConversation'
  );
  await maybeAutoNameAsideConversation({
    agentId,
    conversationId,
    userText: '你觉得呢',
    assistantText: '确实闷，亮一档会好',
    broadcast: () => {},
  });
}

async function titleOf(conversationId: string): Promise<string> {
  const { getConversation } = await import('../../electron/main/conversations/store');
  return (await getConversation(agentId, conversationId)).title;
}

describe('maybeAutoNameAsideConversation', () => {
  it('首轮回复后标题更新；prompt 带指代卡文本；disableReasoning: true', async () => {
    const conv = await makeAsideConv();
    await runNaming(conv.id);
    expect(await titleOf(conv.id)).toBe('配色讨论');
    expect(oneShotCalls).toHaveLength(1);
    expect(oneShotCalls[0].prompt).toContain('这页配色有点闷');
    expect(oneShotCalls[0].prompt).toContain('你觉得呢');
    expect(oneShotCalls[0].disableReasoning).toBe(true);
  });

  it('用户已改名（title ≠ 出生 label）→ 不动、不调 LLM', async () => {
    const conv = await makeAsideConv({ title: '我自己起的名' });
    await runNaming(conv.id);
    expect(await titleOf(conv.id)).toBe('我自己起的名');
    expect(oneShotCalls).toHaveLength(0);
  });

  it('已命名过（title 已非出生 label）再轮触发 → 不重命名', async () => {
    const conv = await makeAsideConv();
    await runNaming(conv.id);
    oneShotResult = '另一个标题';
    await runNaming(conv.id);
    expect(await titleOf(conv.id)).toBe('配色讨论');
    expect(oneShotCalls).toHaveLength(1);
  });

  it('先转正后聊的边角：kind 已是 sub、标题仍是出生 label → 照常命名', async () => {
    const conv = await makeAsideConv({ kind: 'sub' });
    await runNaming(conv.id);
    expect(await titleOf(conv.id)).toBe('配色讨论');
  });

  it('普通对话（首条不是指代卡）→ 短路不调 LLM', async () => {
    const conv = await makeAsideConv({ withReferentCard: false });
    await runNaming(conv.id);
    expect(oneShotCalls).toHaveLength(0);
  });

  it('未配置 conversationTitle → 不命名（与 sub 同一产品决策）', async () => {
    await configureTitleModel(false);
    try {
      const conv = await makeAsideConv();
      await runNaming(conv.id);
      expect(await titleOf(conv.id)).toBe(REFERENT.label);
      expect(oneShotCalls).toHaveLength(0);
    } finally {
      await configureTitleModel(true);
    }
  });

  it('命名失败静默：不抛、标题不动', async () => {
    oneShotFail = true;
    const conv = await makeAsideConv();
    await expect(runNaming(conv.id)).resolves.toBeUndefined();
    expect(await titleOf(conv.id)).toBe(REFERENT.label);
  });
});
