/**
 * subagentChat 补传第二断点（缓存分层修正的配套项）。
 *
 * 现状 subagentChat 只传 stableSystemContext = parentStable，capabilityPrompt 落在
 * 无缓存的动态区——P4/C2 把内容从第一层迁到 capabilityPrompt 后，这些内容对子 agent
 * 会从"第一断点命中"变"每轮全价重发"（项目 CLAUDE.md 可能数 KB、子 agent 工具循环多轮）。
 * 修法：补传 sessionStableSystemContext（子 agent 会话期常量，覆盖 SUFFIX + capabilityPrompt）。
 *
 * 断言子 agent 请求满足 backend 两层前缀不变量（shared/agent/backend.ts）：
 *   systemContext.startsWith(sessionStableSystemContext)
 *   sessionStableSystemContext.startsWith(stableSystemContext)
 * 且 capabilityPrompt 落在 sessionStable 覆盖范围内、stable 段仍逐字等于 parentStable。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';

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
      // 透传事件流——本测试只关心 runConversation 入参，不测观测层
      instrumentConversation: ((_backend, _meta, events) =>
        events) as typeof import('../../electron/main/debug/instrument')['instrumentConversation'],
    }) satisfies Pick<typeof import('../../electron/main/debug/instrument'), 'instrumentConversation'>,
);
vi.mock(
  '../../electron/main/agent/capabilities',
  () =>
    ({
      provisionAgent: vi.fn(async () => ({
        capabilityPrompt: '## 能力段\n\n联网引导 + deck 路由 + 项目 CLAUDE.md',
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

describe('subagentChat 两层缓存断点', () => {
  it('runConversation 入参满足两层前缀不变量，capabilityPrompt 被第二断点覆盖', async () => {
    // bare 模式构造 brand（不触 store）：parentStable = 人格段
    const parentStable = await buildStableSystemContext({
      agentSystemPromptAppend: '父对话稳定段（人格）',
      memoryBPathInstruction: '',
      mcpPrompt: '',
      bare: true,
    });
    const captured: ConversationInput[] = [];
    const abort = new AbortController();

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
        abortSignal: abort.signal,
        inherited: {},
        broadcastChip: () => {},
        persistChip: async () => {},
      },
    );

    expect(captured).toHaveLength(1);
    const input = captured[0];
    const { systemContext, stableSystemContext, sessionStableSystemContext } = input;
    // stable 段逐字等于 parentStable——cache marker 打在主对话相同位置
    expect(stableSystemContext).toBe(parentStable as string);
    // 两层前缀不变量（backend.ts 契约）
    expect(sessionStableSystemContext).toBeDefined();
    expect(sessionStableSystemContext!.startsWith(stableSystemContext!)).toBe(true);
    expect(systemContext!.startsWith(sessionStableSystemContext!)).toBe(true);
    // capabilityPrompt 落在第二断点覆盖范围内（不再每轮全价重发）
    expect(sessionStableSystemContext).toContain('## 能力段');
  });
});
