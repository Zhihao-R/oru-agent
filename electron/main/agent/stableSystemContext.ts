import type { StableSystemContext } from '@shared/agent/backend';
import { getProject } from '../projects/store';
import { loadProjectClaudeMd } from '../projects/claudeMd';
import { buildInstalledPluginsPrompt, buildStandaloneSkillsPrompt } from './pluginPrompt';
import { ORU_IDENTITY_LINE } from '../prompts/identity';
import { CADENCE_RULES } from '../prompts/cadence';
import { OUTPUT_LANGUAGE_RULE } from '../prompts/outputLanguage';
import { TABLE_SCRIPT_RULES } from '../prompts/tableScript';
import { AGENT_GUARDRAILS } from '../prompts/agentGuardrails';
import { buildSelfKnowledgePrompt } from '../prompts/selfKnowledge';

export type BuildStableSystemContextInput = {
  agentSystemPromptAppend?: string | null;
  memoryBPathInstruction: string;
  /** v0.5：MCP server 使用规范（含 chrome-devtools-mcp 等）；空串表示未启用，不拼接 */
  mcpPrompt: string;
  /**
   * 评论场景注入的额外稳定段（任务行为规则）。
   * 拼到 stable 段最后；同 stable 段不变量（跨 task 相同 → cache 命中）。
   */
  extraStableSystemPrompt?: string;
  /**
   * 裸模式（随手评点 aside 短聊）：true 时产物只拼人格（agentSystemPromptAppend）+
   * extraStableSystemPrompt，其余段全部不拼——aside 是只读白名单回合，deck 路由 /
   * 记忆写指引 / mcpPrompt / 插件 skill / 项目 CLAUDE.md 等段都在教模型用白名单外
   * 的工具，留着会与 backend 收口自相矛盾。白名单内的读工具靠自身 description 即可用。
   * 详见 docs/tech/2026-06-10-option-click-meta-comment-tech-design.md 的 systemContext 裁剪段。
   */
  bare?: boolean;
};

const PROJECT_CLAUDE_MD_HEADING = '## 当前项目说明（CLAUDE.md）';

/**
 * 读目标项目的 CLAUDE.md 并裹上标题段；无 active project / 无文件时返回空串。
 * 唯一消费方是 project-claude-md 能力（C2 起 twinMain/twinSubagent/subagentCoder 三方
 * 受众都经它注入，第二层承载）——本段随"当前关注项目"变，不得回到第一层。
 */
export async function loadProjectClaudeMdSection(activeProjectId: string | null): Promise<string> {
  if (!activeProjectId) return '';
  let projectPath: string;
  try {
    const project = await getProject(activeProjectId);
    projectPath = project.path;
  } catch (e) {
    console.warn('[stableSystemContext] getProject 失败，跳过 CLAUDE.md 注入:', e);
    return '';
  }
  const body = await loadProjectClaudeMd(projectPath);
  if (!body || !body.trim()) return '';
  return `${PROJECT_CLAUDE_MD_HEADING}\n\n${body.trim()}`;
}

/**
 * 输出带 StableSystemContext nominal brand 的字符串——这是 brand 的唯一合法构造点。
 *
 * 用途：runner 拿到的 stableSystemContext 自然带 brand，可直接传递给 runSubagent
 * 的 parentStableSystemContext 字段；其他地方拿到的裸 string 编译不过，从源头拦截
 * "误传 full systemContext"（含 dynamic 段）。
 */

export async function buildStableSystemContext(
  input: BuildStableSystemContextInput,
): Promise<StableSystemContext> {
  // 裸模式提前返回：不查插件 / skill 注册表——这些段全不进产物。
  // 仍走本函数构造，保住"brand 唯一合法构造点"不变量。
  if (input.bare) {
    const s = [input.agentSystemPromptAppend, input.extraStableSystemPrompt]
      .filter((s) => s && s.trim().length > 0)
      .join('\n\n---\n\n');
    return s as StableSystemContext;
  }
  // Skill 模块 v1：注册表是内存 Map，纯 sync 读取——本身不影响 cache 命中率
  // （变化时 prefix 会重排 = 该会话剩余请求 cache miss 一次，第 2 期 PRD 已接受）
  const installedPluginsPrompt = buildInstalledPluginsPrompt();
  const standaloneSkillsPrompt = buildStandaloneSkillsPrompt();
  const s = [
    // 身份句恒定首位：anthropic/openaiCompatible 后端下这是主对话唯一的头部身份锚；
    // 完整的自我认知锚点在段尾，不动
    ORU_IDENTITY_LINE,
    input.agentSystemPromptAppend,
    input.memoryBPathInstruction,
    input.mcpPrompt,
    installedPluginsPrompt,
    standaloneSkillsPrompt,
    // deck 路由已迁声明式能力：capabilityPrompt（第二层）承载，不再进第一层
    CADENCE_RULES,
    OUTPUT_LANGUAGE_RULE,
    TABLE_SCRIPT_RULES,
    AGENT_GUARDRAILS,
    // 项目 CLAUDE.md 已迁 project-claude-md 能力：随"当前关注项目"变的段
    // 不进第一层，切项目只击穿第二层 capabilityPrompt
    // 自我认知常驻锚点（子系统 B）：追加在末尾段（extra 之前），紧贴尾部不插中间——
    // 中间插会让其后 token 错位、击穿 prompt cache。bare 分支不拼（aside 不做能力问答）。
    // 装配靠 getAreas()，registry 未就绪时返回纯声明、不抛错。
    buildSelfKnowledgePrompt(),
    input.extraStableSystemPrompt,
  ]
    .filter((s) => s && s.trim().length > 0)
    .join('\n\n---\n\n');
  return s as StableSystemContext;
}
