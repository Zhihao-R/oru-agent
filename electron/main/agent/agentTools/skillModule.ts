/**
 * Skill 模块（v1）：lazy 激活与读取工具。
 *
 * - activate_plugin：把一个已装 plugin 的内部 skill metadata 加载到当前 conversation。
 *   行为：调用 onSkillEvent 写 plugin-activate chip → runner 下一轮扫历史时把 pluginId 加入
 *   ctx.activatedPlugins Set；返回 plugin 内 skill 的 metadata 文本让 LLM 知道哪些 skill 可用。
 *
 * - read_skill：读 SKILL.md 全文给 LLM 看。
 *   行为：跨表解析 skillId（standalone / plugin 内 / builtin），回声防护
 *   （availableFromTimestamp > conversationCreatedAt 拒绝），返回 SKILL.md 全文 +
 *   写一条 skill-call chip。
 */
import type { AgentTool } from '@shared/agent/backend';

export function makeActivatePluginTool(): AgentTool {
  return {
    name: 'activate_plugin',
    mutatesEnvironment: false,
    description:
      '把一个已装 plugin 的内部 skill 元数据加载到当前 conversation。' +
      '当前任务跟某个 plugin 描述匹配时调用，一次调一个。' +
      '幂等：同一 conversation 内重复 activate 同 pluginId 不会出错。' +
      '激活后会列出 plugin 内 skill 名 + description，再用 read_skill 读具体 skill 全文。',
    inputSchema: {
      type: 'object',
      properties: { pluginId: { type: 'string' } },
      required: ['pluginId'],
    },
    async execute(input, ctx) {
      const args = input as { pluginId: string };
      const { getPlugin } = await import('../../plugins/registry');
      const plugin = getPlugin(args.pluginId);
      if (!plugin) {
        return { isError: true, text: `plugin 不存在: ${args.pluginId}` };
      }
      if (!plugin.enabled) {
        return {
          isError: true,
          text: `plugin ${args.pluginId} 被用户在拓展页关闭——无法激活`,
        };
      }
      // 幂等：已激活则直接返回 skill 列表
      const alreadyActivated = !!ctx.activatedPlugins?.has(args.pluginId);
      if (!alreadyActivated && ctx.onSkillEvent) {
        await ctx.onSkillEvent({
          kind: 'plugin-activate',
          pluginId: plugin.id,
          name: plugin.manifest.name,
        });
      }
      if (plugin.skills.length === 0) {
        return {
          text: `Activated plugin "${plugin.manifest.name}"，但该 plugin 没有内含 skill（只含 MCP 或资源）。`,
        };
      }
      const lines = plugin.skills.map((s) => `- ${s.id} — ${s.description}`);
      const body = [
        `Activated plugin "${plugin.manifest.name}". Available skills:`,
        '',
        ...lines,
        '',
        'Call `read_skill` with one of these IDs to get the full SKILL.md content.',
      ].join('\n');
      return { text: body };
    },
  };
}

export function makeReadSkillTool(): AgentTool {
  return {
    name: 'read_skill',
    mutatesEnvironment: false,
    description:
      '读取一个 skill 的 SKILL.md 全文。看过 metadata 知道 skill 有用之后才调。' +
      'skillId 是独立 skill 的 name（如 `writing-oru-skills`）或 plugin 内 skill 的 `plugin-name:skill-name`。' +
      'plugin 内 skill 必须先调 activate_plugin 加载父 plugin 才能读。',
    inputSchema: {
      type: 'object',
      properties: { skillId: { type: 'string' } },
      required: ['skillId'],
    },
    async execute(input, ctx) {
      const args = input as { skillId: string };
      const { resolveSkill } = await import('../../skills/registry');
      const { getPlugin } = await import('../../plugins/registry');
      const createdAt = ctx.conversationCreatedAt ?? Date.now();
      const skill = await resolveSkill(args.skillId, createdAt);
      if (!skill) {
        return {
          isError: true,
          text:
            `skill 不存在或回声防护拒绝: ${args.skillId}（` +
            `可能：skill 名拼错 / 是 plugin 内 skill 但未先 activate_plugin / ` +
            `分身本次对话刚自建 skill 当前轮不可见 —— 下次对话才生效）`,
        };
      }
      // plugin 内 skill：检查父 plugin 已 activate
      if (skill.source === 'plugin' && skill.parentPluginId) {
        const activated = !!ctx.activatedPlugins?.has(skill.parentPluginId);
        if (!activated) {
          return {
            isError: true,
            text: `先 activate_plugin('${skill.parentPluginId}') 再读它内含的 skill ${skill.id}`,
          };
        }
        // 顺便确认 plugin 仍 enabled
        const plugin = getPlugin(skill.parentPluginId);
        if (!plugin?.enabled) {
          return {
            isError: true,
            text: `plugin ${skill.parentPluginId} 被关闭，内含 skill ${skill.id} 不可读`,
          };
        }
      }
      const { promises: fs } = await import('node:fs');
      const { join } = await import('node:path');
      let body: string;
      try {
        body = await fs.readFile(join(skill.path, 'SKILL.md'), 'utf-8');
      } catch (e) {
        return { isError: true, text: `读 SKILL.md 失败: ${(e as Error).message}` };
      }
      // 写 skill-call chip
      if (ctx.onSkillEvent) {
        await ctx.onSkillEvent({ kind: 'skill-call', skillId: skill.id, name: skill.name });
      }
      // bundle 支持：返回里附绝对路径让分身按 SKILL.md 里的相对引用拼路径调 read_file
      return { text: `<oru-skill-path>${skill.path}</oru-skill-path>\n${body}` };
    },
  };
}
