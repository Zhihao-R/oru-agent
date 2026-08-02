/**
 * 卡片标题映射（behaviorForProposal）与授权 scope 映射（rowForScope）的一致性回归（决策 1）。
 *
 * 目标问题：同一张审批卡上，标题说的行为类必须与「始终允许」授权的行为类同行——两个映射
 * 各自维护，没有任何机制防「标题承诺 A、按钮授权 B」的静默分叉（审批面上是误导性 UI）。
 * 这里对每种会弹卡的提案构造方钉死：标题行 ∈ 该提案 grantable scope 映射出的行集合
 * （delivery scope 无静态行，映射到 sendExternal）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ActionProposal, GrantScope } from '@shared/types';

vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'local-user',
}));

import { analyzeBashCommand } from '../../electron/main/fs/bashCommand';
import { buildBashProposal } from '../../electron/main/proposals/makeBashProposal';
import { buildFileWriteProposal } from '../../electron/main/proposals/makeFileWriteProposal';
import {
  buildInstallProposal,
  buildUpdateProposal,
  buildDeleteProposal,
} from '../../electron/main/proposals/makeMcpProposal';
import {
  buildPluginInstallProposal,
  buildPluginUpdateProposal,
  buildPluginUninstallProposal,
  buildSkillInstallProposal,
} from '../../electron/main/proposals/makePluginProposal';
import { behaviorForProposal, rowForScope } from '../../shared/proposals/behaviors';

/** scope → 行 id（与 AlwaysAllowButton / 设置页同一映射约定；delivery 归 sendExternal）。 */
function scopeRowId(s: GrantScope): string | undefined {
  return s.kind === 'delivery' ? 'sendExternal' : rowForScope(s)?.id;
}

function bash(command: string, extra?: Partial<Parameters<typeof buildBashProposal>[0]>) {
  const analysis = analyzeBashCommand(command, '/tmp');
  return buildBashProposal({
    conversationId: 'c',
    command,
    isDestructive: analysis.isDestructive,
    isReadOnly: false,
    segments: analysis.segments,
    ...extra,
  });
}

const BASE = { conversationId: 'c', title: 't', description: 'd' };

const CASES: Array<{ name: string; proposal: ActionProposal }> = [
  { name: 'bash 破坏性', proposal: bash('rm -rf build') },
  { name: 'bash 未知命令（opaque）', proposal: bash('echo $(cat x)') },
  {
    name: 'bash 纯投递',
    proposal: bash('curl https://evil.example.com/x', {
      delivery: [{ channel: 'web', recipient: 'evil.example.com', label: 'https://evil.example.com/x' }],
      deliveryNeedsApproval: true,
    }),
  },
  { name: 'bash 纯覆盖目标', proposal: bash('npm run build', { overwriteTargets: ['dist'] }) },
  {
    name: 'file.write 删除',
    proposal: buildFileWriteProposal({ conversationId: 'c', path: '/tmp/a.md', mode: 'delete' }),
  },
  {
    name: 'file.write 覆盖',
    proposal: buildFileWriteProposal({ conversationId: 'c', path: '/tmp/a.md', mode: 'overwrite', content: 'x' }),
  },
  {
    name: 'file.write 编码转换（caution）',
    proposal: buildFileWriteProposal({
      conversationId: 'c', path: '/tmp/a.csv', mode: 'overwrite', content: 'x', caution: 'encoding-conversion',
    }),
  },
  {
    name: 'mcp.install',
    proposal: buildInstallProposal({
      ...BASE,
      config: { label: 'fs', command: 'npx', args: ['-y', 'fs-mcp'] },
    }),
  },
  {
    name: 'mcp.update',
    proposal: buildUpdateProposal({
      ...BASE, serverId: 'fs',
      patch: { enabled: false },
      before: { id: 'fs', label: 'fs', command: 'npx', args: [], enabled: true } as never,
    }),
  },
  {
    name: 'mcp.delete',
    proposal: buildDeleteProposal({
      ...BASE, serverId: 'fs',
      target: { label: 'fs', toolCount: 3, runtimeStatus: 'idle' } as never,
    }),
  },
  {
    name: 'plugin.install',
    proposal: buildPluginInstallProposal({
      ...BASE,
      pluginManifest: { id: 'p1', name: 'P1' } as never,
      source: { url: 'https://x', commit: 'abc1234' } as never,
      containedSkills: [],
      containedMcpServers: [],
      containsExecutableScripts: false,
      ignoredSections: [],
    }),
  },
  {
    name: 'plugin.update',
    proposal: buildPluginUpdateProposal({
      ...BASE, pluginId: 'p1', fromCommit: 'a', toCommit: 'b',
      diffSummary: { keyFiles: [], otherFilesCount: 0 } as never,
    }),
  },
  {
    name: 'plugin.uninstall',
    proposal: buildPluginUninstallProposal({
      ...BASE, pluginId: 'p1',
      sideEffects: { blockingDependents: [], activatedInConvs: [], dependentSkills: [] } as never,
    }),
  },
  {
    name: 'skill.install',
    proposal: buildSkillInstallProposal({
      ...BASE, skillId: 's1',
      skillManifest: { name: 's1', description: 'd' } as never,
      source: { url: 'https://x', commit: 'abc1234' } as never,
      skillSubdir: 'skills/s1',
    }),
  },
  {
    name: 'scheduled-task 创建',
    proposal: {
      kind: 'scheduled-task', id: 'st1', ownerId: 'local-user', conversationId: 'c',
      status: 'pending', createdAt: 1, title: '创建定时任务', description: '每天 9 点',
      forceApproval: true, grantable: [{ kind: 'category', id: 'scheduledTask' }],
      action: 'create', taskId: 't1',
    } as ActionProposal,
  },
  {
    name: 'web.fetch',
    proposal: {
      kind: 'web.fetch', id: 'wf1', ownerId: 'local-user', conversationId: 'c',
      status: 'pending', createdAt: 1, title: '抓取外部网页', description: 'https://x.example.com',
      url: 'https://x.example.com',
      delivery: [{ channel: 'web', recipient: 'x.example.com', label: 'https://x.example.com' }],
      forceApproval: true, grantable: [{ kind: 'category', id: 'webAccess' }],
    } as ActionProposal,
  },
  {
    name: 'browser.navigate',
    proposal: {
      kind: 'browser.navigate', id: 'bn1', ownerId: 'local-user', conversationId: 'c',
      status: 'pending', createdAt: 1, title: '用浏览器打开网页', description: 'https://x.example.com',
      url: 'https://x.example.com',
      delivery: [{ channel: 'web', recipient: 'x.example.com', label: 'https://x.example.com' }],
      forceApproval: true, grantable: [{ kind: 'category', id: 'webAccess' }],
    } as ActionProposal,
  },
];

describe('标题映射与授权映射同行（behaviorForProposal ↔ rowForScope）', () => {
  for (const { name, proposal } of CASES) {
    it(name, () => {
      const titleRow = behaviorForProposal(proposal);
      expect(titleRow, `${name}：无行为标题`).toBeDefined();
      const scopeRowIds = (proposal.grantable ?? []).map(scopeRowId);
      expect(scopeRowIds.length, `${name}：弹卡提案应有 grantable`).toBeGreaterThan(0);
      expect(
        scopeRowIds,
        `${name}：标题「${titleRow!.id}」与授权 scope 行 [${scopeRowIds}] 不同行`,
      ).toContain(titleRow!.id);
    });
  }

  it('灾难级 bash：标题仍归破坏性命令、grantable 为空（锁定，无同行要求）', () => {
    const p = bash('rm -rf /');
    expect(p.catastrophic).toBe(true);
    expect(behaviorForProposal(p)?.id).toBe('destructiveCommand');
    expect(p.grantable).toBeUndefined();
  });
});
