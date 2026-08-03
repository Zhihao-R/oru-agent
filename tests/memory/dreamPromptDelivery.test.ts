/**
 * 回归：dream 必须把 prompt（episode 索引 + 三份档案）放进 history 末尾的 user 轮。
 *
 * 背景（2026-06-26 bug）：dream 原本传 `userMessage: prompt, history: []`。
 * `userMessage` 只有 claudeCode 后端读；anthropic / openaiCompatible 只认 history 末尾的
 * user 消息（见 shared/agent/backend.ts 契约注释）。memoryDream 跑在 OpenRouter 模型上时，
 * prompt 整段被静默丢弃，模型只收到 system prompt → 夜记变成"我没收到要整理的素材"。
 *
 * 本测试截获 dream 交给 runConversation 的入参，断言 prompt 落在 history 里——
 * 这是非 claudeCode 后端唯一收得到的位置。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, ConversationEvent, ConversationInput } from '@shared/agent/backend';
import type { Agent } from '@shared/types';

let capturedInput: ConversationInput | null = null;

const fakeBackend: AgentBackend = {
  backendType: 'openai-compatible',
  toolProtocol: 'openai-fc',
  runConversation(input) {
    capturedInput = input;
    async function* events(): AsyncIterable<ConversationEvent> {
      yield { type: 'result', resultText: 'done', isError: false };
    }
    return { events: events() };
  },
  runOneShot: async () => ({ text: '' }),
  registerTool() {},
  unregisterTool() {},
  isReady: async () => ({ ok: true, hint: '' }),
};

const fakeAgent: Agent = {
  id: 'agt_x',
  ownerId: 'owner-x',
  name: 'Oru',
  homePath: '/tmp/oru-home',
  systemPromptAppend: null,
  approvalMode: 'work',
  createdAt: 0,
  avatarPath: null,
};

vi.mock('../../electron/main/agent/backends', () => ({
  getBackendFor: vi.fn(async () => fakeBackend),
  resolveThinkingDisable: vi.fn(() => undefined),
}));
vi.mock('../../electron/main/agent/store/agents', () => ({
  listAgents: vi.fn(async () => ({ agents: [fakeAgent], activeId: fakeAgent.id })),
}));
vi.mock('../../electron/main/memory/store', () => ({
  listAllEpisodesWithSuperseded: vi.fn(async () => [
    { relPath: 'agent/user/ep1.md', title: '改主色为绿', description: '配色', mtime: Date.now(), status: 'active' },
  ]),
  readAgentSelf: vi.fn(async () => '人设正文'),
}));
// 档案改走文档模型：dream 读 raw markdown body（readMarkdownFile），不再经 readUserProfile 两段解析。
// mock readMarkdownFile 按路径返回用户档案正文（含'用户偏好极简'），项目档案不存在回 null。
vi.mock('../../electron/main/fs/frontmatter', () => ({
  readMarkdownFile: vi.fn(async (abs: string) =>
    abs.includes('user/profile.md') ? { data: {}, content: '用户偏好极简\n\n画像正文' } : null,
  ),
}));
vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: vi.fn(async () => ({ mode: 'env' })),
  resolveApiKeyForSdk: vi.fn(async () => 'key'),
}));
vi.mock('../../electron/main/engine/subprocessEnv', () => ({
  buildSubprocessEnv: vi.fn(() => ({})),
}));
vi.mock('../../electron/main/debug/instrument', () => ({
  instrumentConversation: (_b: unknown, _m: unknown, events: AsyncIterable<ConversationEvent>) => events,
}));
vi.mock('../../electron/main/memory/changelog', () => ({
  writeNightNote: vi.fn(async () => {}),
}));
vi.mock('../../electron/main/memory/trash', () => ({
  cleanupOldTrash: vi.fn(async () => 0),
}));

describe('dream prompt 投递', () => {
  it('prompt 落在 history 末尾的 user 轮，而非只塞 userMessage', async () => {
    const { runDream } = await import('../../electron/main/memory/dream');
    const outcome = await runDream({ ownerId: 'owner-x', currentProjectId: null });

    expect(outcome.kind).toBe('ok');
    expect(capturedInput).not.toBeNull();

    const history = capturedInput!.history ?? [];
    const lastUser = [...history].reverse().find((m) => m.role === 'user');
    expect(
      lastUser,
      'history 必须含一条 user 消息——否则 anthropic/openaiCompatible 后端收不到 prompt',
    ).toBeDefined();

    // 正文里既有 episode 索引（标题），也有三份档案的内容
    expect(lastUser!.text).toContain('近期 active episode 索引');
    expect(lastUser!.text).toContain('改主色为绿');
    expect(lastUser!.text).toContain('用户偏好极简'); // 用户档案
    expect(lastUser!.text).toContain('人设正文'); // 人设档案
  });
});
