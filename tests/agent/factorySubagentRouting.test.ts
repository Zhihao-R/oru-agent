/**
 * factory 路由分叉 + 文件工具注入
 *
 * 验三条不变量（S02 写入路径收口后）：
 * 1. subagentCoder + 非 anthropic provider（openrouter）→ 构造 OpenAICompatibleBackend（不再 throw）
 *    + 注入的工具集含文件工具（read_file / write_file / edit_file）
 * 2. subagentCoder + anthropic provider → 构造 ClaudeCodeBackend + 文件工具**同样注入**——
 *    SDK 内置 Write/Edit 已禁（DEFAULT_DENIED_BUILTINS），coder 的文件能力与主对话同一套守卫链工具
 * 3. 两条路径都含 bash
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentTool, ToolContext, ToolResult } from '@shared/agent/backend';
import type { BackendProvider, LlmUsage, RegisteredModel, Settings } from '@shared/types';

// factory 依赖 projects/store——只桩 getSettings，避免读真实 settings
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

// ClaudeCodeBackend 依赖 engine——mock 掉避免启动真实 SDK
vi.mock('../../electron/main/engine', () => ({
  engine: {
    run: () => ({
      events: (async function* () {
        yield { type: 'result', resultText: 'ok', isError: false };
      })(),
    }),
    mcp: {
      createServer: () => ({}),
      defineTool: (name: string) => ({ name }),
    },
  },
}));

import { getSettings } from '../../electron/main/projects/store';
import {
  getBackendFor,
  registerTool,
  __clearToolRegistryForTest,
  __listRegisteredToolsForTest,
} from '../../electron/main/agent/backends/factory';
import { makeSettings } from '../helpers/settings';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';

// ─── 存根工具 ─────────────────────────────────────────────────
// execute 里 throw 占位——只测注册行为，不跑执行
function makeStubTool(name: string): AgentTool {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: async (_input: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      throw new Error('stub 工具不执行');
    },
    mutatesEnvironment: false,
    persistPolicy: 'never',
  } satisfies AgentTool;
}

// ─── 文件工具名集（与 factory 过滤函数同源）────────────────────
// read_file 在 agentTools/index.ts 第 88 行（当前 TWIN_BOTH），
// list_dir/grep/glob 第 142-144 行（TWIN_BOTH），
// write_file/edit_file/manage_files 第 145-147 行（TWIN_MAIN）——
// 本 Task 将把这 7 个工具的 usages 数组追加 'subagentCoder'。
const FILE_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'grep',
  'glob',
  'manage_files',
] as const;

// ─── Settings 辅助 ────────────────────────────────────────────
// modelAssignments 全量 null 基底——factory 只读 subagentCoder 那条，其余给 null 即可
const EMPTY_ASSIGNMENTS = {
  twinMain: null,
  twinBackground: null,
  memoryDream: null,
  subagentCoder: null,
  conversationSummary: null,
  conversationTitle: null,
  twinSubagent: null,
  asideComment: null,
  loopReviewer: null,
};

function makeOrSettings(): Settings {
  const provider: BackendProvider = {
    id: 'prov-or',
    type: 'openrouter',
    label: 'OpenRouter Test',
    apiKey: 'sk-test',
  } satisfies BackendProvider;
  const model: RegisteredModel = {
    id: 'model-or-claude',
    providerId: 'prov-or',
    modelId: 'anthropic/claude-sonnet-4-6',
    label: 'Claude via OpenRouter',
  } satisfies RegisteredModel;
  return makeSettings({
    providers: [provider],
    models: [model],
    modelAssignments: { ...EMPTY_ASSIGNMENTS, subagentCoder: model.id },
  });
}

function makeAnthropicSettings(): Settings {
  const provider: BackendProvider = {
    id: 'prov-anth',
    type: 'anthropic',
    label: 'Anthropic Direct',
    apiKey: 'sk-test',
  } satisfies BackendProvider;
  const model: RegisteredModel = {
    id: 'model-anth-sonnet',
    providerId: 'prov-anth',
    modelId: 'claude-sonnet-4-6',
    label: 'Claude Sonnet',
  } satisfies RegisteredModel;
  return makeSettings({
    providers: [provider],
    models: [model],
    modelAssignments: { ...EMPTY_ASSIGNMENTS, subagentCoder: model.id },
  });
}

// ─── 每个 test 前重建注册表 ───────────────────────────────────
// 预注册文件工具 + bash 到 subagentCoder 桶，模拟 Step 3 后的状态
// （真正的注册由 agentTools/index.ts 完成，这里用 stub 替代）
function setupRegistry() {
  __clearToolRegistryForTest();
  for (const name of FILE_TOOL_NAMES) {
    registerTool(makeStubTool(name), ['subagentCoder'] as LlmUsage[]);
  }
  registerTool(makeStubTool('bash'), ['subagentCoder'] as LlmUsage[]);
}

beforeEach(() => {
  setupRegistry();
});

afterEach(() => {
  __clearToolRegistryForTest();
  vi.restoreAllMocks();
});

describe('factory subagentCoder 路由分叉 + 文件工具条件注入（D1）', () => {
  it('openrouter provider → 构造 OpenAICompatibleBackend，工具集含文件工具', async () => {
    vi.mocked(getSettings).mockResolvedValue(makeOrSettings());
    const spy = vi.spyOn(OpenAICompatibleBackend.prototype, 'registerTool');

    const backend = await getBackendFor('subagentCoder');

    expect(backend).toBeInstanceOf(OpenAICompatibleBackend);
    const injected = spy.mock.calls.map(([tool]) => tool.name);
    expect(injected).toContain('read_file');
    expect(injected).toContain('write_file');
    expect(injected).toContain('edit_file');
  });

  it('anthropic provider → 构造 ClaudeCodeBackend，文件工具同样注入（S02：SDK Write/Edit 已禁，写走守卫链）', async () => {
    vi.mocked(getSettings).mockResolvedValue(makeAnthropicSettings());
    const spy = vi.spyOn(ClaudeCodeBackend.prototype, 'registerTool');

    const backend = await getBackendFor('subagentCoder');

    expect(backend).toBeInstanceOf(ClaudeCodeBackend);
    const injected = spy.mock.calls.map(([tool]) => tool.name);
    for (const name of FILE_TOOL_NAMES) {
      expect(injected, `ClaudeCodeBackend 应注入文件工具 ${name}（S02 收口后与主对话同一套）`).toContain(name);
    }
  });

  it('两条路径都含 bash', async () => {
    // openrouter 路径
    vi.mocked(getSettings).mockResolvedValue(makeOrSettings());
    const orSpy = vi.spyOn(OpenAICompatibleBackend.prototype, 'registerTool');
    await getBackendFor('subagentCoder');
    expect(orSpy.mock.calls.map(([t]) => t.name)).toContain('bash');

    // anthropic 路径（重建环境）
    vi.restoreAllMocks();
    setupRegistry();
    vi.mocked(getSettings).mockResolvedValue(makeAnthropicSettings());
    const ccSpy = vi.spyOn(ClaudeCodeBackend.prototype, 'registerTool');
    await getBackendFor('subagentCoder');
    expect(ccSpy.mock.calls.map(([t]) => t.name)).toContain('bash');
  });
});

// ─── twinSubagent / asideComment 透明继承的 bash 口径（G78/G48）──────────
// twinSubagent 桶不在任何工具的 usages 里，靠 injectTools 硬约束透明继承 twinMain。
// 用 twinMain 桶注册工具（含 bash / Task / read_file），验裁剪口径：
//   twinSubagent = twinMain − Task（bash 保留下放，G78/G48）
//   asideComment = twinMain − Task − bash（只读短评不给命令权杖）
function setupTwinMainRegistry() {
  __clearToolRegistryForTest();
  registerTool(makeStubTool('read_file'), ['twinMain'] as LlmUsage[]);
  registerTool(makeStubTool('bash'), ['twinMain'] as LlmUsage[]);
  registerTool(makeStubTool('Task'), ['twinMain'] as LlmUsage[]);
}

describe('twinSubagent / asideComment 透明继承的 bash 裁剪口径（G78/G48）', () => {
  it('twinSubagent 保留 bash、剔除 Task（对话期 subagent 放开命令权杖，回流已接）', async () => {
    setupTwinMainRegistry();
    // 无分配 → OAuth fallback → ClaudeCodeBackend
    vi.mocked(getSettings).mockResolvedValue(makeAnthropicSettings());
    const spy = vi.spyOn(ClaudeCodeBackend.prototype, 'registerTool');

    const backend = await getBackendFor('twinSubagent');

    expect(backend).toBeInstanceOf(ClaudeCodeBackend);
    const injected = spy.mock.calls.map(([t]) => t.name);
    expect(injected, 'twinSubagent 应含 bash（G78/G48 放开）').toContain('bash');
    expect(injected).toContain('read_file');
    expect(injected, 'twinSubagent 仍剔除 Task（嵌套保护）').not.toContain('Task');
  });

  it('asideComment 仍剔除 bash（只读短评不给命令权杖）', async () => {
    setupTwinMainRegistry();
    vi.mocked(getSettings).mockResolvedValue(makeAnthropicSettings());
    const spy = vi.spyOn(ClaudeCodeBackend.prototype, 'registerTool');

    await getBackendFor('asideComment');

    const injected = spy.mock.calls.map(([t]) => t.name);
    expect(injected, 'asideComment 不给 bash').not.toContain('bash');
    expect(injected).not.toContain('Task');
    expect(injected).toContain('read_file');
  });
});

// ─── 计划清单只有主 Oru 记账 ────────────────────────────────────
// 清单是主 Oru 的账本：subagent 干完把结果交回来、由主 Oru 判断动哪一项（它才掌握这段活在整盘
// 计划里的位置）。三个透明继承 twinMain 的桶都要剔掉 todo，不允许出现第二本账。
describe('todo 工具只给主 Oru（不允许第二本账）', () => {
  const INHERITING: LlmUsage[] = ['twinSubagent', 'asideComment', 'scheduledRun'];

  it.each(INHERITING)('%s 透明继承 twinMain，但拿不到 todo', async (usage) => {
    __clearToolRegistryForTest();
    registerTool(makeStubTool('read_file'), ['twinMain'] as LlmUsage[]);
    registerTool(makeStubTool('todo'), ['twinMain'] as LlmUsage[]);
    vi.mocked(getSettings).mockResolvedValue(makeAnthropicSettings());
    const spy = vi.spyOn(ClaudeCodeBackend.prototype, 'registerTool');

    await getBackendFor(usage);

    const injected = spy.mock.calls.map(([t]) => t.name);
    expect(injected, `${usage} 应仍继承普通工具`).toContain('read_file');
    expect(injected, `${usage} 不该拿到 todo`).not.toContain('todo');
  });

  it('twinMain 自己拿得到', async () => {
    __clearToolRegistryForTest();
    registerTool(makeStubTool('todo'), ['twinMain'] as LlmUsage[]);
    vi.mocked(getSettings).mockResolvedValue(makeAnthropicSettings());
    const spy = vi.spyOn(ClaudeCodeBackend.prototype, 'registerTool');

    await getBackendFor('twinMain');

    expect(spy.mock.calls.map(([t]) => t.name)).toContain('todo');
  });

  it('真实注册表里 todo 的 usages 只有 twinMain（subagentCoder 因此也拿不到）', async () => {
    __clearToolRegistryForTest();
    const { registerStaticAgentTools } = await import('../../electron/main/agent/agentTools');
    registerStaticAgentTools();
    const todo = __listRegisteredToolsForTest().find((e) => e.tool.name === 'todo');
    expect(todo?.usages).toEqual(['twinMain']);
  });
});
