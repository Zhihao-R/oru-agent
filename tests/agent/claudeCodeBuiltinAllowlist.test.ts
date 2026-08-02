/**
 * D3-a：默认路径内置工具门收敛到 allowlist 的双向验证。
 *
 * 验的是 ClaudeCodeBackend.runConversation 透传给 engine.run 的 `builtinTools`——
 * 真相源是「模型实际拿到哪些内置工具」，本测试在 engine 边界捕获该入参断言。
 *
 * - 正向：默认路径（无 restrictToolsTo）所需内置工具（Read/Edit/Write/Glob/Grep…）仍可用——扩面不误伤。
 * - 反向（fail-closed）：builtinTools 是显式有限 allowlist（非 undefined），已 deny 的 4 个不在其中，
 *   且任何不在快照里的工具名（模拟 SDK 升级新增）也不在其中——未来新增默认不可见。
 * - 受限路径（aside 只读）：builtinTools 为 []（结构性全关，范本不回退）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';
import type { ConversationInput } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const { runInputs } = vi.hoisted(() => ({ runInputs: [] as EngineRunInput[] }));

vi.mock('../../electron/main/engine', () => {
  async function* oneResult(): AsyncGenerator<EngineEvent> {
    yield { type: 'result', resultText: 'done', isError: false };
  }
  const engine = {
    run: (input: EngineRunInput): EngineRunHandle => {
      runInputs.push(input);
      return { events: oneResult() };
    },
    mcp: {
      createServer: () => ({}),
      defineTool: (name: string) => ({ name }),
    },
  } satisfies CodeExecutionEngine;
  return { engine };
});

// factory 依赖 projects/store——只桩 getSettings，避免拉真实 settings
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

import { ClaudeCodeBackend, DEFAULT_DENIED_BUILTINS } from '../../electron/main/agent/backends/claudeCode';

const toolContext = makeToolContext({
  conversationId: 'conv-1',
  agentId: 'agent-1',
  ownerId: 'owner-1',
  approvalMode: 'work',
  usage: 'twinMain',
});

function makeInput(overrides: Partial<ConversationInput> = {}): ConversationInput {
  return {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    userMessage: '读一下 README',
    cwd: process.cwd(),
    abortController: new AbortController(),
    toolContext,
    ...overrides,
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) void _;
}

afterEach(() => {
  runInputs.length = 0;
});

// 从生产模块同源取 denylist——避免测试手抄副本与代码漂移成假绿（D3-a review #2）。
const DENIED = DEFAULT_DENIED_BUILTINS;
// 默认路径真实需要的内置读工具——这些缺一个都是即时回归。
// Write/Edit 自 S02 写入路径收口起收进 DENIED（写一律走 mcp__oru__ 守卫链），不再属于 REQUIRED。
// WebFetch/WebSearch 自 S04 网络出口收口起收进 DENIED（抓取/搜索一律走 oru 版投递闸），同理移出。
// TodoWrite 收进 DENIED（改由自有 todo 工具接管，写 todoStore 上屏），同理移出。
const REQUIRED = ['Read', 'Glob', 'Grep'];

describe('D3-a 默认路径内置工具门 allowlist', () => {
  it('正向：默认路径透传有限 allowlist，所需读写工具仍在', async () => {
    await drain(new ClaudeCodeBackend('claude-opus-4-8').runConversation(makeInput()).events);
    const builtinTools = runInputs[0].builtinTools;

    // 不再是 fail-open 的 undefined（= SDK 全量），而是显式数组
    expect(Array.isArray(builtinTools)).toBe(true);
    for (const t of REQUIRED) expect(builtinTools).toContain(t);
  });

  it('反向 fail-closed：deny 清单 + 任意快照外新工具都不在 allowlist', async () => {
    await drain(new ClaudeCodeBackend('claude-opus-4-8').runConversation(makeInput()).events);
    const builtinTools = runInputs[0].builtinTools as string[];

    for (const t of DENIED) expect(builtinTools).not.toContain(t);
    // S02 写入路径收口：SDK 内置写工具必须在 deny 清单里（写只走 mcp__oru__ 守卫链）——
    // 显式断言防止未来有人从 DEFAULT_DENIED_BUILTINS 把它们移出去。
    expect(DENIED).toContain('Write');
    expect(DENIED).toContain('Edit');
    // S04 网络出口收口：SDK 内置抓取/搜索必须在 deny 清单里（网络出口只走 oru 版投递闸）
    expect(DENIED).toContain('WebFetch');
    expect(DENIED).toContain('WebSearch');
    // 原生 skill/todo 收口 + 未接线交互工具关死——防止有人从 DEFAULT_DENIED_BUILTINS 移出：
    // Skill/TodoWrite 有自有替代（read_skill / todo），EnterPlanMode/ExitPlanMode 未接线。
    expect(DENIED).toContain('Skill');
    expect(DENIED).toContain('TodoWrite');
    expect(DENIED).toContain('EnterPlanMode');
    expect(DENIED).toContain('ExitPlanMode');
    // 模拟 SDK 升级新增一个内置写工具——它不在冻结快照里，故不在 allowlist（默认不可见）
    expect(builtinTools).not.toContain('SomeFutureSdkWriteTool');
    // disallowedTools 第二层保险仍在（deny 的 4 个都在）
    const disallowed = runInputs[0].disallowedTools ?? [];
    for (const t of DENIED) expect(disallowed).toContain(t);
  });

  it('钩子接线：带 toolContext 的运行挂 PreToolUse 只读闸 + PostToolUse 读同步（S02 · D2）', async () => {
    await drain(new ClaudeCodeBackend('claude-opus-4-8').runConversation(makeInput()).events);
    expect(typeof runInputs[0].hooks?.onPreToolUse).toBe('function');
    expect(typeof runInputs[0].hooks?.onPostToolUse).toBe('function');
  });

  it('受限路径（aside 只读）：builtinTools 为 []（结构性全关）', async () => {
    await drain(
      new ClaudeCodeBackend('claude-opus-4-8').runConversation(makeInput({ restrictToolsTo: ['Read'] })).events,
    );
    expect(runInputs[0].builtinTools).toEqual([]);
  });
});
