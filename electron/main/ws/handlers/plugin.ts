/**
 * plugin.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 plugin.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对动态 import 路径相应多一层 `../`。
 * rememberProposal 从 proposals/registry 取（注册表下沉到 proposal 子系统）；
 * resolveActiveConversationId 从 handlers/systemActionConversation 取。
 */
import type { RegistrySlice } from './types';
import { rememberProposal } from '../../proposals/registry';
import { resolveActiveConversationId } from './systemActionConversation';

export const pluginHandlers = {
  // ─── Skill 模块（v1）─────────────────────────────────────────
  'plugin.list': async (req, { reply }) => {
    const { listPlugins } = await import('../../plugins/registry');
    reply(req.reqId, { type: 'plugin.list.result', plugins: listPlugins() });
  },
  'plugin.get': async (req, { reply }) => {
    const { getPlugin } = await import('../../plugins/registry');
    reply(req.reqId, {
      type: 'plugin.get.result',
      plugin: getPlugin(req.pluginId) ?? null,
    });
  },
  'plugin.install': async (req, { reply, broadcast }) => {
    try {
      const { probePluginFromGithub } = await import('../../plugins/installer');
      const { buildPluginInstallProposal } = await import('../../proposals/makePluginProposal');
      const { runProposalStandalone } = await import('../../proposals/standaloneExec');
      const probe = await probePluginFromGithub(req.githubUrl);
      // 用户从 UI 触发：commit 默认锁 HEAD（即 probe 返回的 commit）；req.commit 显式指定时覆盖
      const lockedCommit = req.commit ?? probe.source.commit;
      const conv = req.conversationId ?? await resolveActiveConversationId(broadcast, '安装插件');
      const proposal = buildPluginInstallProposal({
        conversationId: conv,
        title: `安装 plugin ${probe.manifest.name}`,
        description: probe.manifest.description || `从 ${req.githubUrl} 安装 plugin`,
        pluginManifest: probe.manifest,
        source: { ...probe.source, commit: lockedCommit },
        containedSkills: probe.containedSkills,
        containedMcpServers: probe.containedMcpServers,
        containsExecutableScripts: probe.containsExecutableScripts,
        ignoredSections: probe.ignoredSections,
        mcpConflicts: probe.mcpConflicts.length > 0 ? probe.mcpConflicts : undefined,
      });
      // 临时 clone 目录现在不用了——执行阶段会按 commit 重 clone
      const { promises: fs } = await import('node:fs');
      await fs.rm(probe.tmpCloneDir, { recursive: true, force: true }).catch(() => {});
      rememberProposal(proposal);
      broadcast({ type: 'chat.proposal', conversationId: conv, proposal });
      reply(req.reqId, { type: 'plugin.action.result', ok: true, proposalId: proposal.id });
      // 用户从设置页 UI 手动装插件：是用户主动操作、非 AI 自动行为，**不纳入只读约束**（PRD 范围），
      // 也无"严格"挡可拦——直接执行。（区别于 onProposal:368 的 AI 自动 proposal 那条线。）
      void runProposalStandalone(proposal, broadcast);
    } catch (e) {
      reply(req.reqId, { type: 'plugin.action.result', ok: false, message: (e as Error).message });
    }
  },
  'plugin.uninstall': async (req, { reply, broadcast }) => {
    try {
      const { getPlugin } = await import('../../plugins/registry');
      const { computeUninstallSideEffects } = await import('../../plugins/installer');
      const { buildPluginUninstallProposal } = await import('../../proposals/makePluginProposal');
      const target = getPlugin(req.pluginId);
      if (!target) {
        reply(req.reqId, { type: 'plugin.action.result', ok: false, message: `plugin 不存在: ${req.pluginId}` });
        return;
      }
      const sideEffects = computeUninstallSideEffects(req.pluginId, false);
      const conv = req.conversationId ?? await resolveActiveConversationId(broadcast, '卸载插件');
      const proposal = buildPluginUninstallProposal({
        conversationId: conv,
        title: `卸载 plugin ${target.manifest.name}`,
        description: `卸载 plugin ${target.manifest.name}`,
        pluginId: req.pluginId,
        sideEffects,
      });
      rememberProposal(proposal);
      broadcast({ type: 'chat.proposal', conversationId: conv, proposal });
      reply(req.reqId, { type: 'plugin.action.result', ok: true, proposalId: proposal.id });
    } catch (e) {
      reply(req.reqId, { type: 'plugin.action.result', ok: false, message: (e as Error).message });
    }
  },
  'plugin.update': async (req, { reply, broadcast }) => {
    try {
      const { getPlugin } = await import('../../plugins/registry');
      const { getUpdateDiff } = await import('../../plugins/upgrader');
      const { buildPluginUpdateProposal } = await import('../../proposals/makePluginProposal');
      const target = getPlugin(req.pluginId);
      if (!target) {
        reply(req.reqId, { type: 'plugin.action.result', ok: false, message: `plugin 不存在: ${req.pluginId}` });
        return;
      }
      const diff = await getUpdateDiff(req.pluginId);
      if (!diff) {
        reply(req.reqId, { type: 'plugin.action.result', ok: false, message: '升级 diff 拿不到（plugin 无上游或 git 调用失败）' });
        return;
      }
      if (diff.fromCommit === diff.toCommit) {
        reply(req.reqId, { type: 'plugin.action.result', ok: false, message: '已是最新版本，无需升级' });
        return;
      }
      const conv = req.conversationId ?? await resolveActiveConversationId(broadcast, '更新插件');
      const proposal = buildPluginUpdateProposal({
        conversationId: conv,
        title: `升级 plugin ${target.manifest.name}`,
        description: `从 ${diff.fromCommit.slice(0, 7)} 升级到 ${diff.toCommit.slice(0, 7)}`,
        pluginId: req.pluginId,
        fromCommit: diff.fromCommit,
        toCommit: diff.toCommit,
        diffSummary: {
          keyFiles: diff.keyFiles,
          otherFilesCount: diff.otherFilesCount,
          commitMessages: diff.commitMessages,
        },
      });
      rememberProposal(proposal);
      broadcast({ type: 'chat.proposal', conversationId: conv, proposal });
      reply(req.reqId, { type: 'plugin.action.result', ok: true, proposalId: proposal.id });
    } catch (e) {
      reply(req.reqId, { type: 'plugin.action.result', ok: false, message: (e as Error).message });
    }
  },
  'plugin.checkUpdates': async (req, { reply }) => {
    const { checkPluginUpdates } = await import('../../plugins/upgrader');
    try {
      const updates = await checkPluginUpdates();
      reply(req.reqId, { type: 'plugin.checkUpdates.result', updates });
    } catch {
      reply(req.reqId, { type: 'plugin.checkUpdates.result', updates: [] });
    }
  },
  'plugin.getUpdateDiff': async (req, { reply }) => {
    const { getUpdateDiff } = await import('../../plugins/upgrader');
    try {
      const diff = await getUpdateDiff(req.pluginId);
      reply(req.reqId, { type: 'plugin.getUpdateDiff.result', diff });
    } catch {
      reply(req.reqId, { type: 'plugin.getUpdateDiff.result', diff: null });
    }
  },
  'plugin.setEnabled': async (req, { reply, broadcast }) => {
    try {
      const { setPluginEnabled, listPlugins } = await import('../../plugins/registry');
      const ok = await setPluginEnabled(req.pluginId, req.enabled);
      reply(req.reqId, { type: 'plugin.setEnabled.result', ok, message: ok ? undefined : `plugin 不存在: ${req.pluginId}` });
      if (ok) broadcast({ type: 'plugins.state', plugins: listPlugins() });
    } catch (e) {
      reply(req.reqId, { type: 'plugin.setEnabled.result', ok: false, message: (e as Error).message });
    }
  },
} satisfies RegistrySlice;
