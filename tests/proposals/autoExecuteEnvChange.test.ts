/**
 * 装卸类「在工作挡要不要问人」的判定契约。
 *
 * 判定原本散在两处：autoExecuteDecision 的 kind 常量（桌面 / 渠道用）与 proposeOrExecute 的
 * `forceApproval`（工具用）——后者不认前者，照 kind 那套迁移会让工作挡下连卡都不弹、直接装。
 * 判定已收敛到提案字段这一处，故本文件测的是**构造出来的提案带不带 forceApproval**：
 * 这条抓得住「加了第八个装卸 kind 却忘了补字段」，而通用的 shouldAutoExecuteProposal 抓不住。
 */
import { describe, expect, it } from 'vitest';
import { shouldAutoExecuteProposal } from '../../electron/main/proposals/autoExecuteDecision';
import {
  buildInstallProposal,
  buildUpdateProposal,
  buildDeleteProposal,
} from '../../electron/main/proposals/makeMcpProposal';
import {
  buildPluginInstallProposal,
  buildPluginUninstallProposal,
  buildPluginUpdateProposal,
  buildSkillInstallProposal,
  buildSkillCreateProposal,
  buildSkillPatchProposal,
} from '../../electron/main/proposals/makePluginProposal';
import type { McpServerConfig } from '@shared/types';

const common = { conversationId: 'c1', title: 't', description: 'd' };

describe('装卸类 builder 恒置 forceApproval（工作挡真的还会问人）', () => {
  const built = {
    'mcp.install': () => buildInstallProposal({ ...common, config: { label: 'x', command: 'npx', args: [] } }),
    'mcp.update': () =>
      buildUpdateProposal({
        ...common,
        serverId: 's1',
        patch: { enabled: false },
        before: { id: 's1', label: 'x', command: 'npx', args: [], enabled: true } as McpServerConfig,
      }),
    'mcp.delete': () => buildDeleteProposal({ ...common, serverId: 's1', target: { label: 'x' } }),
    'plugin.install': () =>
      buildPluginInstallProposal({
        ...common,
        pluginManifest: { name: 'p', description: 'd' },
        source: { type: 'github', url: 'u', commit: 'c' },
        containedSkills: [],
        containedMcpServers: [],
        containsExecutableScripts: false,
        ignoredSections: [],
      }),
    'plugin.uninstall': () =>
      buildPluginUninstallProposal({
        ...common,
        pluginId: 'p',
        sideEffects: { activatedInConversation: false, dependentSkills: [], blockingDependents: [] },
      }),
    'plugin.update': () =>
      buildPluginUpdateProposal({ ...common, pluginId: 'p', fromCommit: 'a', toCommit: 'b', diffSummary: undefined }),
    'skill.install': () =>
      buildSkillInstallProposal({
        ...common,
        skillId: 's',
        skillManifest: { name: 's', description: 'd' },
        source: { type: 'github', url: 'u', commit: 'c' },
        skillSubdir: '',
      }),
  };

  for (const [kind, build] of Object.entries(built)) {
    it(`${kind}：forceApproval 为 true，工作挡不自动执行`, () => {
      const p = build();
      expect(p.forceApproval).toBe(true);
      expect(shouldAutoExecuteProposal(p, 'work')).toBe(false);
      expect(shouldAutoExecuteProposal(p, 'readonly')).toBe(false);
      // 全放挡：forceApproval 在 proposeOrExecute 里被挡位分流覆盖（danger 只认 catastrophic），
      // 但 onProposal 这条链上它恒不自动执行——全放挡本就不经这条链（工具自己同步执行完了）。
      expect(shouldAutoExecuteProposal(p, 'danger')).toBe(false);
    });
  }
});

describe('内容创作类留空 forceApproval（非只读挡恒自动执行，口径不变）', () => {
  it('skill.create / skill.patch 不带 forceApproval', () => {
    const create = buildSkillCreateProposal({
      ...common,
      skillName: 's',
      skillDescription: 'd',
      skillMd: '---\nname: s\ndescription: d\n---\n',
    });
    const patch = buildSkillPatchProposal({
      ...common,
      target: 'skill',
      name: 's',
      oldString: 'a',
      newString: 'b',
      diffPreview: '',
      targetDescription: 'd',
    });
    expect(create.forceApproval).toBeUndefined();
    expect(patch.forceApproval).toBeUndefined();
    expect(shouldAutoExecuteProposal(create, 'work')).toBe(true);
    expect(shouldAutoExecuteProposal(patch, 'danger')).toBe(true);
    expect(shouldAutoExecuteProposal(create, 'readonly')).toBe(false);
  });
});

describe('既有口径不回归', () => {
  it('forceApproval 恒不自动执行', () => {
    expect(shouldAutoExecuteProposal({ kind: 'mcp.install', forceApproval: true }, 'danger')).toBe(false);
    expect(shouldAutoExecuteProposal({ kind: 'skill.create', forceApproval: true }, 'work')).toBe(false);
  });
  it('派工（code）不过挡位（S02 · G73）', () => {
    expect(shouldAutoExecuteProposal({ kind: 'code' }, 'readonly')).toBe(true);
  });
});
