/**
 * 环境变更类工具「等结果再说话」的回归（2026-07-28 提案执行同步化）。
 *
 * 事故现场：全放挡装 skill，工具立刻回一句「已在后台异步执行，几秒后落定，在收到结果前别宣告
 * 完成」——结果永远回不到本轮，模型能做的唯一动作就是再发一次，于是同一回合两张卡、一红一绿，
 * 收尾还说「等审批通过就会装好」（全放挡下根本没有审批在等）。
 *
 * 本文件按「回执断言的事实，在工具返回那一刻是否已经成立」逐条钉死：
 *   1. 回执闭环——返回时盘上真的有了（重复调用不再发生的机制保证）
 *   2. 失败如实回报——不吞、不预告
 *   3. 工作挡真的还在弹卡——补 forceApproval 忘了会在这里红
 *   4. 设置页路径不回归——它从没有工具在等，必须走独立执行器而非被判僵尸卡
 *   5. 终态只迁一次 / in-flight 守卫仍在 / 无 UI 不死锁 / 留痕卡四条硬约束
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActionProposal, SkillInstallProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import type { ToolContext } from '@shared/agent/backend';

const ORU_DIR = join(tmpdir(), `oru-test-envsync-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const SKILLS_DIR = join(ORU_DIR, 'skills');
const SRC_ROOT = join(tmpdir(), `oru-test-envsync-src-${Date.now()}`);

// 挡位实时读会打真实 agent store；测试里按 ctx.approvalMode 回落即可（agent 不存在时本就回落）。
vi.mock('../../electron/main/agent/store/agents', async (orig) => {
  const actual = await orig<typeof import('../../electron/main/agent/store/agents')>();
  return { ...actual, getAgent: vi.fn(async () => null) satisfies typeof actual.getAgent };
});

async function writeLocalSkill(name: string): Promise<string> {
  const root = join(SRC_ROOT, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a skill named ${name}\n---\n\n# ${name}\n`,
    'utf-8',
  );
  return root;
}

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: 'conv-envsync',
    agentId: 'agent-envsync',
    ownerId: 'local-user',
    approvalMode: 'danger',
    usage: 'twinMain',
    abortSignal: new AbortController().signal,
    ...over,
  } satisfies ToolContext;
}

async function localInstallTool() {
  const { makeProposeSkillInstallLocalTool } = await import(
    '../../electron/main/agent/agentTools/plugin'
  );
  return makeProposeSkillInstallLocalTool();
}

beforeEach(async () => {
  await fs.mkdir(SKILLS_DIR, { recursive: true });
  const reg = await import('../../electron/main/skills/registry');
  reg.__resetForTest();
});
afterEach(async () => {
  await fs.rm(SKILLS_DIR, { recursive: true, force: true });
  const reg = await import('../../electron/main/skills/registry');
  reg.__resetForTest();
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
  await fs.rm(SRC_ROOT, { recursive: true, force: true });
});

describe('回执闭环：返回那一刻事实已经成立', () => {
  it('全放挡装 skill：回执带真实结果，且返回前已落盘 + 已注册', async () => {
    const src = await writeLocalSkill('tarot-sync');
    const r = await (await localInstallTool()).execute({ localPath: src }, makeCtx());

    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('tarot-sync');
    // 「已装好」这个断言在返回那一刻必须成立——这条是重复调用不再发生的机制保证
    expect(existsSync(join(SKILLS_DIR, 'tarot-sync', 'SKILL.md'))).toBe(true);
    const { getSkill } = await import('../../electron/main/skills/registry');
    expect(getSkill('tarot-sync')?.source).toBe('standalone');
    // 不再有任何「等审批 / 后台执行」的预告
    expect(r.text).not.toMatch(/已递交|后台异步|等用户/);
  });

  it('失败如实回报：目标已存在 → isError 带真实错因，不说已装好', async () => {
    const src = await writeLocalSkill('dup-sync');
    await fs.mkdir(join(SKILLS_DIR, 'dup-sync'), { recursive: true });

    const r = await (await localInstallTool()).execute({ localPath: src }, makeCtx());

    expect(r.isError).toBe(true);
    expect(r.text).toContain('目标目录已存在'); // 回执是技术原文，不随界面语言变
  });

  it('MCP 装失败：回执带上游错因（不是一句「已在后台执行」）', async () => {
    const registry = await import('../../electron/main/mcp/registry');
    const createSpy = vi
      .spyOn(registry, 'createServer')
      .mockResolvedValue({ id: 'srv_x', label: 'x', command: 'npx', args: [], enabled: true } as never);
    vi.spyOn(registry, 'getRuntimeState').mockReturnValue({
      serverId: 'srv_x',
      status: 'failed',
      lastError: 'spawn ENOENT',
    } as never);
    const deleteSpy = vi.spyOn(registry, 'deleteServer').mockResolvedValue(true);

    const { makeMcpInstallTool } = await import('../../electron/main/agent/agentTools/mcp');
    const r = await makeMcpInstallTool().execute(
      { label: 'x', command: 'npx', args: [] },
      makeCtx(),
    );

    expect(r.isError).toBe(true);
    expect(r.text).toContain('spawn ENOENT');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith('srv_x'); // 半坏 server 已回滚，不污染 Settings
    vi.restoreAllMocks();
  });
});

describe('工作挡真的还在弹卡（补 forceApproval 忘了会在这里红）', () => {
  it('未批准前不落盘；批准后才装，且真实结果回原轮', async () => {
    const src = await writeLocalSkill('gated-sync');
    let seen: ActionProposal | null = null;
    const dest = join(SKILLS_DIR, 'gated-sync');

    const running = (await localInstallTool()).execute(
      { localPath: src },
      makeCtx({
        approvalMode: 'work',
        onProposal: async (p) => {
          seen = p;
        },
      }),
    );
    await vi.waitFor(() => expect(seen).not.toBeNull());

    // 卡已弹、决定未落：盘上一定还什么都没有
    expect(existsSync(dest)).toBe(false);
    expect((seen as unknown as SkillInstallProposal).forceApproval).toBe(true);

    const { settleProposalDecision } = await import('../../electron/main/proposals/pendingDecision');
    expect(settleProposalDecision(seen!.id, 'approved')).toBe(true);

    const r = await running;
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
  });

  it('拒绝：不落盘，回执如实说被拒', async () => {
    const src = await writeLocalSkill('rejected-sync');
    const r = await (await localInstallTool()).execute(
      { localPath: src },
      makeCtx({
        approvalMode: 'work',
        onProposal: async (p) => {
          const { settleProposalDecision } = await import(
            '../../electron/main/proposals/pendingDecision'
          );
          settleProposalDecision(p.id, 'rejected');
        },
      }),
    );
    expect(r.text).toContain('用户拒绝');
    expect(existsSync(join(SKILLS_DIR, 'rejected-sync'))).toBe(false);
  });

  it('无 UI 场景（没挂 onProposal）：不执行、不死锁，回退到提案文案', async () => {
    const src = await writeLocalSkill('headless-sync');
    const r = await (await localInstallTool()).execute(
      { localPath: src },
      makeCtx({ approvalMode: 'work' }),
    );
    expect(r.text).toContain('没有可确认的界面'); // 回执如实说「没人能点、没做」，不预告一个不存在的审批
    expect(existsSync(join(SKILLS_DIR, 'headless-sync'))).toBe(false);
  });
});

describe('设置页路径不回归：从没有工具在等的卡照常执行', () => {
  it('裸造的 skill.install 卡（无 waiter）点确认 → 真执行，不被判僵尸卡置 rejected', async () => {
    const src = await writeLocalSkill('settings-sync');
    const { buildSkillInstallProposal } = await import(
      '../../electron/main/proposals/makePluginProposal'
    );
    const proposal = buildSkillInstallProposal({
      conversationId: 'conv-envsync',
      title: '装 settings-sync',
      description: '设置页起的卡',
      skillId: 'settings-sync',
      skillManifest: { name: 'settings-sync', description: 'd' },
      source: { type: 'local', path: src },
      skillSubdir: '',
    });
    const { rememberProposal } = await import('../../electron/main/proposals/registry');
    rememberProposal(proposal);

    const events: ServerEvent[] = [];
    const { settleApprovalDecision } = await import(
      '../../electron/main/ws/handlers/settleApprovalDecision'
    );
    await settleApprovalDecision({
      proposalId: proposal.id,
      decision: 'approved',
      always: false,
      by: { kind: 'user' },
      broadcast: (ev) => events.push(ev),
    });

    await vi.waitFor(() => expect(proposal.status).toBe('executed'));
    expect(existsSync(join(SKILLS_DIR, 'settings-sync', 'SKILL.md'))).toBe(true);
    // 终态只迁一次：executing → executed，中间不许有第二条 executed / failed
    const statuses = events
      .filter((e) => e.type === 'proposal.statusChanged')
      .map((e) => (e as { status: string }).status);
    expect(statuses).toEqual(['executing', 'executed']);
  });
});

describe('in-flight 守卫在新路径仍生效', () => {
  it('并发两个同 skillId 的安装：第二个被守卫拒，不撞写同一目录', async () => {
    const src = await writeLocalSkill('race-sync');
    const { performSkillInstall } = await import('../../electron/main/skills/installer');
    const { buildSkillInstallProposal } = await import(
      '../../electron/main/proposals/makePluginProposal'
    );
    const make = () =>
      buildSkillInstallProposal({
        conversationId: 'conv-envsync',
        title: '装 race-sync',
        description: 'd',
        skillId: 'race-sync',
        skillManifest: { name: 'race-sync', description: 'd' },
        source: { type: 'local', path: src },
        skillSubdir: '',
      });

    const results = await Promise.allSettled([
      performSkillInstall(make()),
      performSkillInstall(make()),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/正在安装中|已安装/);
    expect(existsSync(join(SKILLS_DIR, 'race-sync', 'SKILL.md'))).toBe(true);
  });
});

describe('留痕卡四条硬约束（§2.4）', () => {
  it('全放挡：以终态出现、不以 pending 出现、不经审批链、同 proposal 只广播一张', async () => {
    const src = await writeLocalSkill('trace-sync');
    const traced: ActionProposal[] = [];
    const approvalCards: ActionProposal[] = [];

    const r = await (await localInstallTool()).execute(
      { localPath: src },
      makeCtx({
        onProposal: async (p) => approvalCards.push(p), // 审批链：全放挡下绝不该被调
        onProposalTrace: async (p) => traced.push(p),
      }),
    );

    expect(r.isError).toBeFalsy();
    expect(approvalCards).toHaveLength(0); // 约束 2：不经承载「审批请求」语义的那条链
    expect(traced).toHaveLength(1); // 约束 3：与审批卡互斥，只出一张
    expect(traced[0]!.status).toBe('executed'); // 约束 1：恒终态，绝不 pending
    expect(traced[0]!.trace).toBe(true);
    // 不进注册表——误发 proposal.execute 不会凭空装第二遍
    const { getProposal } = await import('../../electron/main/proposals/registry');
    expect(getProposal(traced[0]!.id)).toBeUndefined();
  });

  it('失败时留痕卡带 failureMessage（用户没见过审批卡，这是他唯一的现场）', async () => {
    const src = await writeLocalSkill('trace-fail');
    await fs.mkdir(join(SKILLS_DIR, 'trace-fail'), { recursive: true });
    const traced: ActionProposal[] = [];

    const r = await (await localInstallTool()).execute(
      { localPath: src },
      makeCtx({ onProposalTrace: async (p) => traced.push(p) }),
    );

    expect(r.isError).toBe(true);
    expect(traced).toHaveLength(1);
    expect(traced[0]!.status).toBe('failed');
    // 卡上是 owner 语言的说法（已知失败取词），只断言「错因落上了、指明是哪个目标」
    expect(traced[0]!.failureMessage).toBeTruthy();
    expect(traced[0]!.failureMessage).toContain('trace-fail');
  });

  it('工作挡批准后不补留痕卡（否则同 id 两张，前端不去重会渲染两遍）', async () => {
    const src = await writeLocalSkill('trace-approved');
    const traced: ActionProposal[] = [];

    const r = await (await localInstallTool()).execute(
      { localPath: src },
      makeCtx({
        approvalMode: 'work',
        onProposal: async (p) => {
          const { settleProposalDecision } = await import(
            '../../electron/main/proposals/pendingDecision'
          );
          settleProposalDecision(p.id, 'approved');
        },
        onProposalTrace: async (p) => traced.push(p),
      }),
    );

    expect(r.isError).toBeFalsy();
    expect(traced).toHaveLength(0);
  });
});
