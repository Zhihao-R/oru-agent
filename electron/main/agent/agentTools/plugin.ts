/**
 * Plugin 自管能力：分身用的工具（Skill 模块 v1）。
 *
 * - 读类（无审批）：plugin_list（已装清单）
 * - 写类（受审批挡位控制）：propose_plugin_install / propose_plugin_uninstall / 两个 skill 安装
 *   写类内部：浅 clone 探测 → 构造 proposal → proposeOrExecuteEnvChange（免审批直装、需审批则
 *   挂起等确认），**真实成败作为回执在原轮回给模型**——不预告一件还没发生的事。
 *
 * 装 plugin 是低频用户动作——LLM 仅在用户明确请求"装 plugin X"时调用。
 */
import type { AgentTool } from '@shared/agent/backend';
import {
  buildPluginInstallProposal,
  buildPluginUninstallProposal,
  buildSkillInstallProposal,
} from '../../proposals/makePluginProposal';
import { proposeOrExecuteEnvChange } from './emitProposal';

export function makePluginListTool(): AgentTool {
  return {
    name: 'plugin_list',
    mutatesEnvironment: false,
    description:
      '列出当前已装的所有 plugin——名字、内含 skill / MCP 数量、激活描述。' +
      '用户问"装了哪些 plugin / 能做哪些专项任务"时先调这个。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const { listPlugins } = await import('../../plugins/registry');
      const list = listPlugins().map((p) => ({
        id: p.id,
        name: p.manifest.name,
        description: p.manifest.description,
        activationDescription: p.oruExtension.activationDescription,
        version: p.manifest.version,
        skillCount: p.skills.length,
        mcpCount: p.mcpServers.length,
        enabled: p.enabled,
        source: p.oruExtension.source.url,
        commit: p.oruExtension.source.commit?.slice(0, 7) ?? '',
      }));
      return { text: JSON.stringify(list, null, 2) };
    },
  };
}

export function makeProposePluginInstallTool(): AgentTool {
  return {
    name: 'propose_plugin_install',
    mutatesEnvironment: true,
    description:
      '从 GitHub URL 安装一个 plugin。会先浅 clone 探测：解析 plugin.json、扫 skill / MCP 清单、' +
      '检查 MCP 名冲突；需要用户过目时探测结果会展示在卡片上。装好前不会返回——回执里是真实成败。' +
      '调用前必须先 web_search 找到准确的 github URL（如 github.com/feishu-community/oru-feishu-plugin）。',
    inputSchema: {
      type: 'object',
      properties: {
        githubUrl: {
          type: 'string',
          description: '完整 GitHub URL，如 https://github.com/owner/repo',
        },
      },
      required: ['githubUrl'],
    },
    async execute(input, ctx) {
      const args = input as { githubUrl: string };
      try {
        const { probePluginFromGithub } = await import('../../plugins/installer');
        const probe = await probePluginFromGithub(args.githubUrl);
        const proposal = buildPluginInstallProposal({
          conversationId: ctx.conversationId,
          title: `建议安装 plugin ${probe.manifest.name}`,
          description:
            probe.manifest.description ||
            `从 ${args.githubUrl} 安装 plugin`,
          pluginManifest: probe.manifest,
          source: probe.source,
          containedSkills: probe.containedSkills,
          containedMcpServers: probe.containedMcpServers,
          containsExecutableScripts: probe.containsExecutableScripts,
          ignoredSections: probe.ignoredSections,
          mcpConflicts: probe.mcpConflicts.length > 0 ? probe.mcpConflicts : undefined,
        });
        // 清理临时 clone 目录——真实安装时会重新 clone
        const { promises: fs } = await import('node:fs');
        await fs.rm(probe.tmpCloneDir, { recursive: true, force: true }).catch(() => {});
        return await proposeOrExecuteEnvChange(ctx, proposal, {
          approvalText: `当前环境没有可确认的界面，未安装 plugin ${probe.manifest.name}。`,
          perform: async () => {
            const { performPluginInstall } = await import('../../plugins/installer');
            const r = await performPluginInstall(proposal);
            const warned = r.warnings.length > 0 ? `（有 ${r.warnings.length} 处非致命警告，见对话流）` : '';
            return {
              text: `plugin ${r.name} 已装好${warned}，内含的 skill 可用 read_skill 读。`,
              outcome: { ok: true, name: r.name, warnings: r.warnings },
            };
          },
        });
      } catch (e) {
        return { isError: true, text: `安装 plugin 失败：${(e as Error).message}` };
      }
    },
  };
}

export function makeProposeSkillInstallTool(): AgentTool {
  return {
    name: 'propose_skill_install',
    mutatesEnvironment: true,
    description:
      '从 GitHub URL 安装一个独立 skill（不是 plugin）。先浅 clone 探测：找 SKILL.md（repo 根或 skills/<x>/）、' +
      '解析 name/description；落盘到 ~/.oru/skills/，之后 read_skill 即可读。装好前不会返回——回执里是真实成败。' +
      '用户想装某个网上找的 skill（如 deck/PPT 风格 skill）时调用；deck 默认 skill 缺失时系统会自动走这条路。',
    inputSchema: {
      type: 'object',
      properties: {
        githubUrl: { type: 'string', description: '完整 GitHub URL，如 https://github.com/owner/repo' },
        skillId: {
          type: 'string',
          description: '可选：钉定注册表 id（= 安装目录裸名）。缺省用 repo 名 / skills 子目录名推导。',
        },
      },
      required: ['githubUrl'],
    },
    async execute(input, ctx) {
      const args = input as { githubUrl: string; skillId?: string };
      try {
        const { probeSkillFromGithub } = await import('../../skills/installer');
        const probe = await probeSkillFromGithub(args.githubUrl, args.skillId);
        const proposal = buildSkillInstallProposal({
          conversationId: ctx.conversationId,
          title: `建议安装 skill ${probe.manifest.name}`,
          description: probe.manifest.description || `从 ${args.githubUrl} 安装 skill`,
          skillId: probe.skillId,
          skillManifest: probe.manifest,
          source: probe.source,
          skillSubdir: probe.skillSubdir,
        });
        // 清理临时 clone——真实安装时会重新 clone
        const { promises: fs } = await import('node:fs');
        await fs.rm(probe.tmpCloneDir, { recursive: true, force: true }).catch(() => {});
        return await proposeOrExecuteEnvChange(ctx, proposal, {
          approvalText: `当前环境没有可确认的界面，未安装 skill ${probe.manifest.name}。`,
          perform: async () => {
            const { performSkillInstall } = await import('../../skills/installer');
            const r = await performSkillInstall(proposal);
            return {
              text: `skill ${r.name} 已装好（id: ${r.skillId}），现在就能用 read_skill 读它。`,
              outcome: { ok: true, name: r.name },
            };
          },
        });
      } catch (e) {
        return { isError: true, text: `安装 skill 失败：${(e as Error).message}` };
      }
    },
  };
}

export function makeProposeSkillInstallLocalTool(): AgentTool {
  return {
    name: 'propose_skill_install_local',
    mutatesEnvironment: true,
    description:
      '从本地文件夹装一个独立 skill（不是从 GitHub）。用户给了一个本地路径、或把下载好的 skill ' +
      '文件夹交给你时用这个——先探测该目录的 SKILL.md（根或 skills/<x>/）、解析 name/description，' +
      '再复制到 ~/.oru/skills/，装完即刻可用（无需重启）。装好前不会返回——回执里是真实成败。' +
      '**不要用 bash cp / mv 手动把 skill 文件夹拷进 ~/.oru/skills/**——那样绕过注册，运行期看不见。',
    inputSchema: {
      type: 'object',
      properties: {
        localPath: {
          type: 'string',
          description: 'skill 所在本地目录的绝对路径（含 SKILL.md，或其下 skills/<x>/ 含）',
        },
        skillId: {
          type: 'string',
          description: '可选：钉定注册表 id（= 安装目录裸名）。缺省用 SKILL.md 所在目录名推导。',
        },
      },
      required: ['localPath'],
    },
    async execute(input, ctx) {
      const args = input as { localPath: string; skillId?: string };
      try {
        const { probeSkillFromLocal } = await import('../../skills/installer');
        const probe = await probeSkillFromLocal(args.localPath, args.skillId);
        const proposal = buildSkillInstallProposal({
          conversationId: ctx.conversationId,
          title: `建议安装 skill ${probe.manifest.name}`,
          description: probe.manifest.description || `从本地目录 ${args.localPath} 安装 skill`,
          skillId: probe.skillId,
          skillManifest: probe.manifest,
          source: probe.source,
          skillSubdir: probe.skillSubdir,
        });
        return await proposeOrExecuteEnvChange(ctx, proposal, {
          approvalText: `当前环境没有可确认的界面，未安装 skill ${probe.manifest.name}。`,
          perform: async () => {
            const { performSkillInstall } = await import('../../skills/installer');
            const r = await performSkillInstall(proposal);
            return {
              text: `skill ${r.name} 已从本地目录装好（id: ${r.skillId}），现在就能用 read_skill 读它。`,
              outcome: { ok: true, name: r.name },
            };
          },
        });
      } catch (e) {
        return { isError: true, text: `从本地目录安装 skill 失败：${(e as Error).message}` };
      }
    },
  };
}

export function makeProposePluginUninstallTool(): AgentTool {
  return {
    name: 'propose_plugin_uninstall',
    mutatesEnvironment: true,
    description:
      '卸载一个已装 plugin。会先检查副作用（依赖 / 当前会话激活 / 阻塞依赖），需要用户过目时一并展示在卡片上。' +
      'blockingDependents 非空时执行阶段会拒绝，回执里给出是谁在依赖它。',
    inputSchema: {
      type: 'object',
      properties: {
        pluginId: { type: 'string', description: 'plugin_list 返回的 id（即 plugin manifest name）' },
      },
      required: ['pluginId'],
    },
    async execute(input, ctx) {
      const args = input as { pluginId: string };
      try {
        const { getPlugin } = await import('../../plugins/registry');
        const { computeUninstallSideEffects } = await import('../../plugins/installer');
        const target = getPlugin(args.pluginId);
        if (!target) {
          return { isError: true, text: `plugin 不存在: ${args.pluginId}` };
        }
        const activatedInConversation = !!ctx.activatedPlugins?.has(args.pluginId);
        const sideEffects = computeUninstallSideEffects(args.pluginId, activatedInConversation);
        const proposal = buildPluginUninstallProposal({
          conversationId: ctx.conversationId,
          title: `建议卸载 plugin ${target.manifest.name}`,
          description: `卸载 plugin ${target.manifest.name}`,
          pluginId: args.pluginId,
          sideEffects,
        });
        return await proposeOrExecuteEnvChange(ctx, proposal, {
          approvalText: `当前环境没有可确认的界面，未卸载 plugin ${target.manifest.name}。`,
          perform: async () => {
            const { performPluginUninstall } = await import('../../plugins/installer');
            const r = await performPluginUninstall(proposal);
            return {
              text: `plugin ${r.name} 已卸载：内含 MCP 已停、目录已删。`,
              outcome: { ok: true, name: r.name },
            };
          },
        });
      } catch (e) {
        return { isError: true, text: `卸载 plugin 失败：${(e as Error).message}` };
      }
    },
  };
}
