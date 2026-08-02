/**
 * Skill 模块（v1）：拼装 plugin / skill 在 stable system prompt 里的两段文本。
 *
 * - installedPluginsPrompt：列已装 enabled plugin 的 name + 激活描述
 *   → 让 LLM 知道有这些 plugin 存在，按需 activate_plugin 加载内部 skill
 * - standaloneSkillsPrompt：列独立装 + 内置 skill 的 name + description
 *   → 立即可用，LLM 直接 read_skill 调用
 *
 * 注意 prompt cache：装/卸/升级 plugin 或独立 skill = stable prefix 内容变 →
 * 当前会话剩余请求 cache 一次性 miss，后续会话稳定。低频操作可接受。
 */
import { listPlugins } from '../plugins/registry';
import { listStandaloneSkills } from '../skills/registry';

export function buildInstalledPluginsPrompt(): string {
  const plugins = listPlugins().filter((p) => p.enabled);
  if (plugins.length === 0) return '';
  const lines = plugins.map((p) => {
    const desc = p.oruExtension.activationDescription ?? p.manifest.description;
    return `- ${p.id} — ${desc}`;
  });
  return [
    '## 已装 Plugin（按需激活）',
    '',
    '你有以下 plugin 可用。每个 plugin 是一组针对特定领域的 skill + MCP 打包。' +
      '当用户任务跟某个 plugin 的描述匹配时，调 `activate_plugin` 把该 plugin 的内部 skill 元数据加载到当前对话。' +
      '激活是一次性的：同一对话内同 pluginId 重复 activate 是幂等的。',
    '',
    ...lines,
  ].join('\n');
}

export function buildStandaloneSkillsPrompt(): string {
  // 用户在设置页关掉的 skill 不进 prompt——分身看不到激活机会
  const skills = listStandaloneSkills().filter((s) => s.enabled);
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.id} — ${s.description}`);
  return [
    '## 立即可用 Skill',
    '',
    '以下 skill 装上即生效，直接调 `read_skill` 拿到 SKILL.md 全文按其指令做事：',
    '',
    ...lines,
  ].join('\n');
}
