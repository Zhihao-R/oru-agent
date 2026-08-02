/**
 * 工作挡下装卸类的卡真的能点（2026-07-28 提案执行同步化 §2.3 前端半边）。
 *
 * 现存缺陷：两张卡的 autoExecuting 判据是 `!isReadonly`——非只读挡一律渲染成「自动执行中…」
 * 的转圈，批准按钮根本不渲染。而后端 2026-07-10 起装卸类在工作挡是要等确认的，两边合起来
 * 就是死结：后端等确认、前端不给按钮，卡永远悬着，用户只能 discard。同步化后这个死结会升级
 * 成整轮挂死。判据改为「这张卡要不要审批」（forceApproval），本文件钉死它。
 *
 * 与后端那条（tests/proposals/envChangeSync.test.ts「工作挡真的还在弹卡」）互为另一半：
 * 那条测后端真的停下等，这条测用户真的点得到。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/ws', () => ({ wsClient: { request } }));

import { McpProposalCard } from '@/components/proposalCards/McpProposalCard';
import { SkillModuleProposalCard } from '@/components/proposalCards/SkillModuleProposalCard';
import { useAgentStore } from '@/stores/agentStore';
import type {
  Agent,
  ApprovalMode,
  McpInstallProposal,
  PluginInstallProposal,
  SkillCreateProposal,
  SkillInstallProposal,
} from '@shared/types';

function setMode(approvalMode: ApprovalMode) {
  useAgentStore.setState({
    activeAgentId: 'twin',
    agents: [{ id: 'twin', approvalMode } as Agent],
  });
}

const base = {
  id: 'p1',
  ownerId: 'u',
  conversationId: 'c',
  title: '装点东西',
  description: 'd',
  createdAt: 1,
  status: 'pending' as const,
};

const mcpInstall: McpInstallProposal = {
  ...base,
  kind: 'mcp.install',
  forceApproval: true,
  config: { label: 'linear', command: 'npx', args: ['-y', '@linear/mcp'] },
};

const pluginInstall: PluginInstallProposal = {
  ...base,
  kind: 'plugin.install',
  forceApproval: true,
  pluginManifest: { name: 'demo', description: '演示插件' },
  source: { type: 'github', url: 'https://example.com/demo', commit: 'abc' },
  containedSkills: [],
  containedMcpServers: [],
  containsExecutableScripts: false,
  ignoredSections: [],
};

const skillInstall: SkillInstallProposal = {
  ...base,
  kind: 'skill.install',
  forceApproval: true,
  skillId: 'tarot',
  skillManifest: { name: 'tarot', description: 'd' },
  source: { type: 'github', url: 'https://example.com/tarot', commit: 'abc' },
  skillSubdir: '',
};

/** 内容创作类不带 forceApproval——非只读挡本就自动执行，转圈才是对的。 */
const skillCreate: SkillCreateProposal = {
  ...base,
  kind: 'skill.create',
  skillName: 'my-flow',
  skillDescription: 'd',
  skillMd: '---\nname: my-flow\ndescription: d\n---\n',
};

/** 批准按钮——找不到即抛（正是「按钮根本不渲染」那个缺陷的现场）。 */
function approveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /让他去做|允许/ }) as HTMLButtonElement;
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({});
  setMode('work');
});
afterEach(() => cleanup());

describe('工作挡：需审批的装卸卡给出可点的批准按钮', () => {
  it('mcp.install', () => {
    render(<McpProposalCard proposal={mcpInstall} />);
    expect(screen.queryByText('自动执行中…')).toBeNull();
    expect(approveButton().disabled).toBe(false);
  });

  it('plugin.install', () => {
    render(<SkillModuleProposalCard proposal={pluginInstall} />);
    expect(screen.queryByText('自动执行中…')).toBeNull();
    expect(approveButton().disabled).toBe(false);
  });

  it('skill.install', () => {
    render(<SkillModuleProposalCard proposal={skillInstall} />);
    expect(screen.queryByText('自动执行中…')).toBeNull();
    expect(approveButton().disabled).toBe(false);
  });
});

describe('不需要审批的卡仍然只转圈（语义不变）', () => {
  it('skill.create 在工作挡后端就是自动执行的，不该给按钮', () => {
    render(<SkillModuleProposalCard proposal={skillCreate} />);
    expect(screen.getByText('自动执行中…')).toBeTruthy();
  });

  it('只读挡：装卸卡不转圈（那时是用户在决定要不要放行）', () => {
    setMode('readonly');
    render(<McpProposalCard proposal={mcpInstall} />);
    expect(screen.queryByText('自动执行中…')).toBeNull();
  });
});
