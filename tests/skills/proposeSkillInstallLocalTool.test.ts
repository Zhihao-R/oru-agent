/**
 * propose_skill_install_local 工具：从本地文件夹装 skill（source=local）。
 * 让 Oru 有一等公民路径装本地 skill，不再 bash cp 绕过热注册。
 *
 * 工作挡下它是同步等确认的（提案带 forceApproval）——用例必须真的替用户做个决定，
 * 否则工具会一直挂着（那正是「卡真的在等人」的证据）。这里一律拒绝：本文件只验提案构造，
 * 落盘行为由 tests/skills/localInstall.test.ts 覆盖。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '@shared/agent/backend';
import type { ActionProposal, SkillInstallProposal } from '@shared/types';

const SRC = join(tmpdir(), `oru-test-localtool-${Date.now()}`);

// 工作挡：提案弹卡后同步等决定——回调里立刻替用户点「拒绝」，工具才会返回。
const ctx: ToolContext = {
  conversationId: 'c1',
  agentId: 'twin',
  ownerId: 'o',
  approvalMode: 'work',
  usage: 'twinMain',
  abortSignal: new AbortController().signal,
  onProposal: vi.fn(async (p: ActionProposal) => {
    const { settleProposalDecision } = await import('../../electron/main/proposals/pendingDecision');
    settleProposalDecision(p.id, 'rejected');
  }),
};

async function writeLocalSkill(name: string, description = `a skill ${name}`): Promise<void> {
  await fs.mkdir(SRC, { recursive: true });
  await fs.writeFile(
    join(SRC, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    'utf-8',
  );
}

describe('propose_skill_install_local', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    await fs.rm(SRC, { recursive: true, force: true });
  });
  afterAll(async () => {
    await fs.rm(SRC, { recursive: true, force: true });
  });

  it('mutatesEnvironment=true（受审批挡位管）', async () => {
    const { makeProposeSkillInstallLocalTool } = await import(
      '../../electron/main/agent/agentTools/plugin'
    );
    expect(makeProposeSkillInstallLocalTool().mutatesEnvironment).toBe(true);
  });

  it('合法本地文件夹 → 递交 skill.install 提案，source.type=local', async () => {
    const { makeProposeSkillInstallLocalTool } = await import(
      '../../electron/main/agent/agentTools/plugin'
    );
    await writeLocalSkill('draw-ascii-tarot');

    const r = await makeProposeSkillInstallLocalTool().execute({ localPath: SRC }, ctx);

    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('用户拒绝'); // 真的等到了决定才返回，不是预告
    expect(ctx.onProposal).toHaveBeenCalledTimes(1);
    const proposal = vi.mocked(ctx.onProposal!).mock.calls[0][0] as ActionProposal;
    expect(proposal.kind).toBe('skill.install');
    const install = proposal as SkillInstallProposal;
    expect(install.source).toEqual({ type: 'local', path: SRC });
    expect(install.skillManifest.name).toBe('draw-ascii-tarot');
  });

  it('缺 SKILL.md → isError，不递交提案', async () => {
    const { makeProposeSkillInstallLocalTool } = await import(
      '../../electron/main/agent/agentTools/plugin'
    );
    await fs.mkdir(SRC, { recursive: true }); // 空目录

    const r = await makeProposeSkillInstallLocalTool().execute({ localPath: SRC }, ctx);

    expect(r.isError).toBe(true);
    expect(ctx.onProposal).not.toHaveBeenCalled();
  });
});
