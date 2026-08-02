/**
 * 回归：主对话「继承组」(InheritedToolContext) 整组流向对话期 subagent 的 ToolContext。
 *
 * 背景（2026-07-22 盘点 M5）：必须原样继承给 subagent 的回调/激活态原本在三处手抄清单
 * （主 ctx 装配 / RunSubagentDeps / subagent ctx 装配）里人肉对齐，漏一个不报错、只是工具
 * 静默失能（代码里两处「修分叉」注释即实证）。收敛为 InheritedToolContext 后 subagent 侧
 * 整组 `...deps.inherited` 透传，本测试锁死「组里每个字段都自动到达 subagent ctx」——
 * 谁把 spread 改回逐字段手抄、或新增字段没进组，都会红。
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentBackend,
  ConversationInput,
  InheritedToolContext,
} from '@shared/agent/backend';

vi.mock(
  '../../electron/main/agent/subagentChat/sidecar',
  () =>
    ({
      ensureSidecarDir: vi.fn(async () => {}),
      appendSidecarMessage: vi.fn(async () => {}),
    }) satisfies Pick<
      typeof import('../../electron/main/agent/subagentChat/sidecar'),
      'ensureSidecarDir' | 'appendSidecarMessage'
    >,
);
vi.mock(
  '../../electron/main/debug/instrument',
  () =>
    ({
      instrumentConversation: ((_backend, _meta, events) =>
        events) as typeof import('../../electron/main/debug/instrument')['instrumentConversation'],
    }) satisfies Pick<typeof import('../../electron/main/debug/instrument'), 'instrumentConversation'>,
);
vi.mock(
  '../../electron/main/agent/capabilities',
  () =>
    ({
      provisionAgent: vi.fn(async () => ({
        capabilityPrompt: '',
        toolContextPatch: {},
        extraDisallowed: [],
      })),
    }) satisfies Pick<typeof import('../../electron/main/agent/capabilities'), 'provisionAgent'>,
);
vi.mock(
  '../../electron/main/search/budget',
  () =>
    ({
      finalizeConversationBudget: vi.fn(),
    }) satisfies Pick<typeof import('../../electron/main/search/budget'), 'finalizeConversationBudget'>,
);

import { runSubagent } from '../../electron/main/agent/subagentChat/runner';
import { buildStableSystemContext } from '../../electron/main/agent/stableSystemContext';

function makeCapturingBackend(captured: ConversationInput[]): AgentBackend {
  return {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    runConversation(input: ConversationInput) {
      captured.push(input);
      return {
        events: (async function* () {
          yield { type: 'result' as const, resultText: '子任务完成', isError: false };
        })(),
      };
    },
    runOneShot: async () => ({ text: '' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: '' }),
  } satisfies AgentBackend;
}

describe('subagent 继承组透传', () => {
  it('InheritedToolContext 的每个字段都自动到达 subagent 的 ToolContext', async () => {
    const parentStable = await buildStableSystemContext({
      agentSystemPromptAppend: '父对话稳定段',
      memoryBPathInstruction: '',
      mcpPrompt: '',
      bare: true,
    });

    // 每个字段给独立哨兵引用，逐个断言「同引用到达」——不是「碰巧都有值」
    const inherited: InheritedToolContext = {
      onMemoryRecord: vi.fn(async () => {}),
      onGitHint: vi.fn(async () => {}),
      onArtifactSubmissionChanged: vi.fn(async () => {}),
      onProposal: vi.fn(async () => {}),
      onSkillEvent: vi.fn(async () => {}),
      askUserChoice: vi.fn(async () => {}),
      onCircuitBreak: vi.fn(async () => {}),
      activatedPlugins: new Set(['plugin-a', 'plugin-b']),
    };

    const captured: ConversationInput[] = [];
    await runSubagent(
      { description: '测试任务', prompt: '做一件小事' },
      {
        conversationId: 'conv-1',
        agentId: 'agent-1',
        agentName: 'Oru',
        ownerId: 'owner-1',
        backend: makeCapturingBackend(captured),
        parentStableSystemContext: parentStable,
        cwd: '/tmp',
        approvalMode: 'work',
        abortSignal: new AbortController().signal,
        inherited,
        broadcastChip: () => {},
        persistChip: async () => {},
      },
    );

    expect(captured).toHaveLength(1);
    const ctx = captured[0].toolContext!;

    // 结构断言：组里每个 key 都出现在 subagent ctx（防「改回逐字段手抄漏一个」）
    for (const key of Object.keys(inherited) as (keyof InheritedToolContext)[]) {
      expect(ctx[key], `继承组字段 ${key} 应到达 subagent ctx`).toBeDefined();
    }

    // 原样继承（同引用）——onProposal 例外：subagent 会包装注入 triggeredBySubagent
    expect(ctx.onMemoryRecord).toBe(inherited.onMemoryRecord);
    expect(ctx.onGitHint).toBe(inherited.onGitHint);
    expect(ctx.onArtifactSubmissionChanged).toBe(inherited.onArtifactSubmissionChanged);
    expect(ctx.onSkillEvent).toBe(inherited.onSkillEvent);
    expect(ctx.onCircuitBreak).toBe(inherited.onCircuitBreak);
    expect(ctx.askUserChoice).toBe(inherited.askUserChoice);
    expect(ctx.activatedPlugins).toBe(inherited.activatedPlugins);

    // onProposal 被包装（present 但非同引用）
    expect(ctx.onProposal).toBeDefined();
    expect(ctx.onProposal).not.toBe(inherited.onProposal);

    // askUserChoice 挂着 → ask_twin 同步提问通道就位（taskId + askTwinResolver）
    expect(ctx.taskId).toBeTruthy();
    expect(ctx.askTwinResolver).toBeDefined();

    // 嵌套保护：subagent 不挂 runSubagent
    expect(ctx.runSubagent).toBeUndefined();
  });
});
