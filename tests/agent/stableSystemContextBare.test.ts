/**
 * buildStableSystemContext 裸模式（随手评点 aside 短聊的 systemContext 裁剪）。
 *
 * aside 是只读白名单回合：全套 stable 段里节奏规则 / 记忆写指引 / mcpPrompt /
 * 插件 skill 段都在教模型用白名单外的工具，裸模式必须全砍，只留人格 + extraStable
 * （aside 行为规则由调用方经 extraStable 注入）。deck 路由与项目 CLAUDE.md 已迁
 * 声明式能力，不再是第一层成员。
 *
 * 验证三件事：
 * - 裸模式产物只含人格 + extraStable，各被砍段的特征文本一概不出现，且不读项目 CLAUDE.md；
 * - 非裸模式产物与改动前的拼接完全一致（精确等值断言，防回归）；
 * - 两种模式都经同一个函数返回 StableSystemContext brand（编译期保证，唯一合法构造点不变）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PluginRecord, SkillRecord } from '@shared/types';

// stableSystemContext 只从 store 取 getProject、从 claudeMd 取 loadProjectClaudeMd——
// 桩掉这两个文件级依赖，避免拉起真实 config 落盘
vi.mock(
  '../../electron/main/projects/store',
  () =>
    ({
      getProject: vi.fn(),
    }) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getProject'>,
);
vi.mock(
  '../../electron/main/projects/claudeMd',
  () =>
    ({
      loadProjectClaudeMd: vi.fn(),
    }) satisfies Pick<typeof import('../../electron/main/projects/claudeMd'), 'loadProjectClaudeMd'>,
);

import { getProject } from '../../electron/main/projects/store';
import { loadProjectClaudeMd } from '../../electron/main/projects/claudeMd';
import { buildStableSystemContext } from '../../electron/main/agent/stableSystemContext';
import {
  buildInstalledPluginsPrompt,
  buildStandaloneSkillsPrompt,
} from '../../electron/main/agent/pluginPrompt';
import { ORU_IDENTITY_LINE } from '../../electron/main/prompts/identity';
import { CADENCE_RULES } from '../../electron/main/prompts/cadence';
import { OUTPUT_LANGUAGE_RULE } from '../../electron/main/prompts/outputLanguage';
import { TABLE_SCRIPT_RULES } from '../../electron/main/prompts/tableScript';
import { AGENT_GUARDRAILS } from '../../electron/main/prompts/agentGuardrails';
import { buildSelfKnowledgePrompt } from '../../electron/main/prompts/selfKnowledge';
import {
  upsertPlugin,
  __resetForTest as resetPluginRegistry,
} from '../../electron/main/plugins/registry';
import {
  upsertSkill,
  __resetForTest as resetSkillRegistry,
} from '../../electron/main/skills/registry';

const SEP = '\n\n---\n\n';
const PERSONA = '人格：你是 Oru，与用户结盟的他者';
const MEMORY_WRITE_GUIDE = '## 记忆\n\n对话里出现稳定的用户事实——调 record_memory 写下来';
const MCP_PROMPT = '## MCP server 使用规范\n\nchrome-devtools 操作真实浏览器';
const EXTRA_STABLE = '## aside 行为规则\n\n短答、不接任务、不写盘';

const PLUGIN = {
  id: 'demo-plugin',
  manifest: { name: 'demo-plugin', description: '演示插件' },
  oruExtension: {
    activationDescription: '处理演示场景',
    source: { type: 'github', url: 'https://example.com', commit: 'abc' },
    installedAt: 0,
  },
  skills: [],
  mcpServers: [],
  ignoredSections: [],
  enabled: true,
} satisfies PluginRecord;

const SKILL = {
  id: 'demo-skill',
  name: 'demo-skill',
  description: '演示 skill',
  path: '/fake/skills/demo-skill',
  source: 'standalone',
  availableFromTimestamp: 0,
  enabled: true,
} satisfies SkillRecord;

/** 全量入参基线——两种模式喂同一份，差异只来自 bare 开关 */
const fullInput = {
  agentSystemPromptAppend: PERSONA,
  memoryBPathInstruction: MEMORY_WRITE_GUIDE,
  mcpPrompt: MCP_PROMPT,
  extraStableSystemPrompt: EXTRA_STABLE,
};

beforeEach(() => {
  upsertPlugin(PLUGIN);
  upsertSkill(SKILL);
});

afterEach(() => {
  vi.clearAllMocks();
  resetPluginRegistry();
  resetSkillRegistry();
});

describe('buildStableSystemContext 非裸模式（回归基线）', () => {
  it('产物与改动前的拼接完全一致：全段按既有顺序、既有分隔符', async () => {
    const result = await buildStableSystemContext(fullInput);
    const expected = [
      // 身份句恒定在首位：anthropic/openaiCompatible 后端下主对话没有别的头部身份，
      // 它是 stable 段的恒定身份锚
      ORU_IDENTITY_LINE,
      PERSONA,
      MEMORY_WRITE_GUIDE,
      MCP_PROMPT,
      buildInstalledPluginsPrompt(),
      buildStandaloneSkillsPrompt(),
      // deck 路由已迁声明式能力：第二层 capabilityPrompt 承载，不再进第一层
      CADENCE_RULES,
      OUTPUT_LANGUAGE_RULE,
      TABLE_SCRIPT_RULES,
      AGENT_GUARDRAILS,
      // 项目 CLAUDE.md 已迁 project-claude-md 能力：第二层承载，切项目不击穿第一层
      // 自我认知常驻锚点（子系统 B）：追加在末尾段（extra 之前）。
      // 本测试不 init selfKnowledge registry，故装配出的是纯诚实声明（无领域线索，降级路径）。
      buildSelfKnowledgePrompt(),
      EXTRA_STABLE,
    ].join(SEP);
    expect(result).toBe(expected);
  });

  it('含输出语言 meta 规则（D4）：跟对话语言、不跟界面语言', async () => {
    const result = await buildStableSystemContext(fullInput);
    expect(result).toContain(OUTPUT_LANGUAGE_RULE);
    expect(result).toContain('not the app');
  });

  it('不传 bare 与 bare: false 等价——开关不开零变化', async () => {
    const implicit = await buildStableSystemContext(fullInput);
    const explicit = await buildStableSystemContext({ ...fullInput, bare: false });
    expect(explicit).toBe(implicit);
  });
});

describe('buildStableSystemContext 裸模式（aside 短聊）', () => {
  it('产物只含人格 + extraStable，精确等值', async () => {
    const result = await buildStableSystemContext({ ...fullInput, bare: true });
    expect(result).toBe(`${PERSONA}${SEP}${EXTRA_STABLE}`);
  });

  it('各被砍段的特征文本一概不出现', async () => {
    const result = await buildStableSystemContext({ ...fullInput, bare: true });
    // deck 路由提示（"必须用 propose_deck_create"）
    expect(result).not.toContain('propose_deck_create');
    // 节奏规则
    expect(result).not.toContain('## 节奏');
    // 记忆写指引（教模型调 record_memory）
    expect(result).not.toContain('record_memory');
    // mcpPrompt
    expect(result).not.toContain('MCP server 使用规范');
    // 插件 / skill 段
    expect(result).not.toContain('已装 Plugin');
    expect(result).not.toContain('demo-plugin');
    expect(result).not.toContain('立即可用 Skill');
    expect(result).not.toContain('demo-skill');
    // 项目 CLAUDE.md 段
    expect(result).not.toContain('CLAUDE.md');
    // 行为护栏段（裸模式只读白名单，不注入行为规则）
    expect(result).not.toContain('## 边界');
    // 输出语言 meta 规则（D4）也属主链段，裸模式不带
    expect(result).not.toContain('## Output language');
    // 自我认知锚点（子系统 B）裸模式也不带——aside 不做能力问答
    expect(result).not.toContain('你是谁、怎么谈论自己的能力');
    // 身份句裸模式也不拼——与现有裁剪口径一致
    expect(result).not.toContain(ORU_IDENTITY_LINE);
  });

  it('不读项目 CLAUDE.md——该段已迁能力，两种模式都不触发 getProject', async () => {
    await buildStableSystemContext({ ...fullInput, bare: true });
    await buildStableSystemContext(fullInput);
    expect(vi.mocked(getProject)).not.toHaveBeenCalled();
    expect(vi.mocked(loadProjectClaudeMd)).not.toHaveBeenCalled();
  });

  it('无 extraStable 时只剩人格，不带分隔符', async () => {
    const result = await buildStableSystemContext({
      ...fullInput,
      bare: true,
      extraStableSystemPrompt: undefined,
    });
    expect(result).toBe(PERSONA);
  });
});
