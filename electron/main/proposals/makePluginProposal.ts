/**
 * Skill 模块（v1）：构造 plugin/skill 系列 ActionProposal 的辅助。
 *
 * 由 agentTools/plugin.ts / agentTools/skillManage.ts / WS handlers 调用。
 *
 * 装卸类（plugin 三件套 + skill.install）置 `forceApproval: true`——「这类操作在工作挡要不要
 * 问人」的判定收敛在提案字段这一处（原先散在 autoExecuteDecision 的 kind 常量里）；2026-07-30
 * 决策 7 各挂整类授权（plugin / skillInstall），默认仍问、「始终允许」后同类免卡。
 * skill.create / skill.patch 是内容创作而非装卸，非只读挡恒自动执行，**留空才是对的**。
 */
import type {
  PluginInstallProposal,
  PluginUpdateProposal,
  PluginUninstallProposal,
  SkillCreateProposal,
  SkillPatchProposal,
  SkillInstallProposal,
} from '@shared/types';
import { newProposalId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';

export function buildPluginInstallProposal(args: {
  conversationId: string;
  title: string;
  description: string;
  pluginManifest: PluginInstallProposal['pluginManifest'];
  source: PluginInstallProposal['source'];
  containedSkills: PluginInstallProposal['containedSkills'];
  containedMcpServers: PluginInstallProposal['containedMcpServers'];
  containsExecutableScripts: boolean;
  ignoredSections: string[];
  mcpConflicts?: PluginInstallProposal['mcpConflicts'];
}): PluginInstallProposal {
  return {
    kind: 'plugin.install',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    forceApproval: true,
    grantable: [{ kind: 'category', id: 'plugin' }],
    pluginManifest: args.pluginManifest,
    source: args.source,
    containedSkills: args.containedSkills,
    containedMcpServers: args.containedMcpServers,
    containsExecutableScripts: args.containsExecutableScripts,
    ignoredSections: args.ignoredSections,
    mcpConflicts: args.mcpConflicts,
  };
}

export function buildPluginUpdateProposal(args: {
  conversationId: string;
  title: string;
  description: string;
  pluginId: string;
  fromCommit: string;
  toCommit: string;
  diffSummary: PluginUpdateProposal['diffSummary'];
}): PluginUpdateProposal {
  return {
    kind: 'plugin.update',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    forceApproval: true,
    grantable: [{ kind: 'category', id: 'plugin' }],
    pluginId: args.pluginId,
    fromCommit: args.fromCommit,
    toCommit: args.toCommit,
    diffSummary: args.diffSummary,
  };
}

export function buildPluginUninstallProposal(args: {
  conversationId: string;
  title: string;
  description: string;
  pluginId: string;
  sideEffects: PluginUninstallProposal['sideEffects'];
}): PluginUninstallProposal {
  return {
    kind: 'plugin.uninstall',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    forceApproval: true,
    grantable: [{ kind: 'category', id: 'plugin' }],
    pluginId: args.pluginId,
    sideEffects: args.sideEffects,
  };
}

export function buildSkillCreateProposal(args: {
  conversationId: string;
  title: string;
  description: string;
  skillName: string;
  skillDescription: string;
  skillMd: string;
  scripts?: SkillCreateProposal['scripts'];
}): SkillCreateProposal {
  return {
    kind: 'skill.create',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    skillName: args.skillName,
    skillDescription: args.skillDescription,
    skillMd: args.skillMd,
    scripts: args.scripts,
  };
}

export function buildSkillInstallProposal(args: {
  conversationId: string;
  title: string;
  description: string;
  skillId: string;
  skillManifest: SkillInstallProposal['skillManifest'];
  source: SkillInstallProposal['source'];
  skillSubdir: string;
  license?: string;
}): SkillInstallProposal {
  return {
    kind: 'skill.install',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    forceApproval: true,
    grantable: [{ kind: 'category', id: 'skillInstall' }],
    skillId: args.skillId,
    skillManifest: args.skillManifest,
    source: args.source,
    skillSubdir: args.skillSubdir,
    license: args.license,
  };
}

export function buildSkillPatchProposal(args: {
  conversationId: string;
  title: string;
  description: string;
  target: SkillPatchProposal['target'];
  name: string;
  oldString: string;
  newString: string;
  diffPreview: string;
  targetDescription: string;
}): SkillPatchProposal {
  return {
    kind: 'skill.patch',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: args.title,
    description: args.description,
    createdAt: Date.now(),
    target: args.target,
    name: args.name,
    oldString: args.oldString,
    newString: args.newString,
    diffPreview: args.diffPreview,
    targetDescription: args.targetDescription,
  };
}
