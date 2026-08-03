/**
 * 审批决定收口回归（S24 · G30/G130）——settleApprovalDecision 是桌面/渠道共用出口。
 *
 * 目标问题（新行为，既有 route/finalize 回归已覆盖驱动执行本身）：
 * - 「始终允许」批准 → 全部 grantable scope 写入持久授权清单；「仅此一次」不写。
 * - 决定落定 → 一条 kind:'proposal' 存证消息随对话历史落盘（decision/by/summary 正确）+ 广播。
 * - 先到先得：并发批准+拒绝只一个生效、卡片唯一结局（认领门）。
 * - 渠道投影：决定落定后 refresh 到终态（经注册的投影器）。
 *
 * 走真实 store（tmp ORU_DIR）+ 动态 import（避免 paths.ts load 锁死 ORU_DIR）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BashProposal, CodeActionProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';

// code 提案 approve 会 enqueueTask 派工——掐掉，只验决定收口的落盘行为，不真跑 subagent。
vi.mock('../../electron/main/tasks/queue', async (orig) => ({
  ...(await orig<typeof import('../../electron/main/tasks/queue')>()),
  enqueue: vi.fn(),
}));

const ORU_DIR = join(tmpdir(), `oru-test-settle-approval-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const AGENT_ID = 'twin';
let CONV_ID = '';
let seq = 0;

type Settle = typeof import('../../electron/main/ws/handlers/settleApprovalDecision');
type Registry = typeof import('../../electron/main/proposals/registry');
type Grants = typeof import('../../electron/main/proposals/grants/store');
type Convs = typeof import('../../electron/main/conversations/store');
type Proj = typeof import('../../electron/main/platform/approvalProjection');
let settle: Settle;
let registry: Registry;
let grants: Grants;
let convs: Convs;
let proj: Proj;

function bashProposal(over: Partial<BashProposal> = {}): BashProposal {
  return {
    id: `prop_settle_${seq++}`,
    ownerId: 'local-user',
    conversationId: CONV_ID,
    title: '跑命令',
    description: '测试',
    createdAt: 1,
    status: 'pending',
    kind: 'bash',
    command: 'rm -rf build',
    isDestructive: true,
    isReadOnly: false,
    segments: [{ text: 'rm -rf build', destructive: true }],
    grantable: [{ kind: 'destructive' }],
    ...over,
  } satisfies BashProposal;
}

describe('settleApprovalDecision', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
    const agents = await import('../../electron/main/agent/store/agents');
    await agents.ensureDefaultAgent();
    convs = await import('../../electron/main/conversations/store');
    const conv = await convs.createSubConversation(AGENT_ID, '审批测试');
    CONV_ID = conv.id;
    settle = await import('../../electron/main/ws/handlers/settleApprovalDecision');
    registry = await import('../../electron/main/proposals/registry');
    grants = await import('../../electron/main/proposals/grants/store');
    proj = await import('../../electron/main/platform/approvalProjection');
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });
  beforeEach(async () => {
    grants.__resetGrantsCacheForTest();
    proj.__resetApprovalProjectionForTest();
    // 清掉上一条 grants
    await fs.rm(join(ORU_DIR, 'users', 'local-user', 'grants.json'), { force: true });
    grants.__resetGrantsCacheForTest();
  });

  const decisions = (events: ServerEvent[]) =>
    events.filter((e) => e.type === 'proposal.statusChanged').map((e) => (e as { status: string }).status);

  it('始终允许 → 写入 grantable 全部 scope；仅此一次不写', async () => {
    // 仅此一次（always:false）：不弹卡由 emit 端处理，这里直接测 settle 不写授权
    const p1 = bashProposal();
    registry.rememberProposal(p1);
    await settle.settleApprovalDecision({
      proposalId: p1.id,
      decision: 'approved',
      always: false,
      by: { source: 'desktop' },
      broadcast: () => {},
    });
    expect(await grants.isGranted({ kind: 'destructive' })).toBe(false);

    // 始终允许（always:true）：写入 destructive 授权
    const p2 = bashProposal();
    registry.rememberProposal(p2);
    await settle.settleApprovalDecision({
      proposalId: p2.id,
      decision: 'approved',
      always: true,
      by: { source: 'desktop' },
      broadcast: () => {},
    });
    expect(await grants.isGranted({ kind: 'destructive' })).toBe(true);
  });

  it('决定落定 → kind:proposal 存证随历史落盘（decision/by/summary）+ 广播', async () => {
    const p = bashProposal({ command: 'rm -rf dist' });
    registry.rememberProposal(p);
    const events: ServerEvent[] = [];
    await settle.settleApprovalDecision({
      proposalId: p.id,
      decision: 'rejected',
      always: false,
      by: { source: 'channel', platform: 'feishu', userId: 'ou_123' },
      broadcast: (ev) => events.push(ev),
    });
    await new Promise((r) => setTimeout(r, 30)); // 存证是 fire-and-forget（disk append + 广播）
    // 广播 chat.proposalRecord
    const rec = events.find((e) => e.type === 'chat.proposalRecord');
    expect(rec).toBeDefined();
    // 历史里有一条 kind:proposal 存证
    const history = await convs.readHistory(AGENT_ID, CONV_ID);
    const record = history.find((m) => m.kind === 'proposal' && m.refId === p.id);
    expect(record?.proposalRecord?.decision).toBe('rejected');
    expect(record?.proposalRecord?.by).toEqual({ source: 'channel', platform: 'feishu', userId: 'ou_123' });
    expect(record?.proposalRecord?.summary).toBe('rm -rf dist');
  });

  it('存证消息 createdAt 继承原提案时间戳（钉在活卡原位，不置底）', async () => {
    // 回归：存证卡在对话流的排序键是消息 createdAt（ChatArea 按 ts 排序）。曾误填 Date.now()（决定
    // 落定时刻），导致存证卡时间戳最新、被排到整个流的底部而非钉在触发它的工具调用之后。决定时刻
    // 应只记在 proposalRecord.decidedAt；消息 createdAt 必须继承提案 createdAt，让存证卡替换活卡原位。
    const p = bashProposal({ createdAt: 42, command: 'rm -rf tmp' });
    registry.rememberProposal(p);
    await settle.settleApprovalDecision({
      proposalId: p.id,
      decision: 'rejected',
      always: false,
      by: { source: 'desktop' },
      broadcast: () => {},
    });
    await new Promise((r) => setTimeout(r, 30)); // 存证 fire-and-forget
    const history = await convs.readHistory(AGENT_ID, CONV_ID);
    const record = history.find((m) => m.kind === 'proposal' && m.refId === p.id);
    expect(record?.createdAt).toBe(42); // 继承提案时间戳，不是 Date.now()
    expect(record?.proposalRecord?.decidedAt).toBeGreaterThan(42); // 决定时刻另记在 decidedAt
  });

  it('先到先得：并发批准+拒绝只一个生效', async () => {
    const p = bashProposal();
    registry.rememberProposal(p);
    const a = await settle.settleApprovalDecision({
      proposalId: p.id,
      decision: 'approved',
      always: false,
      by: { source: 'desktop' },
      broadcast: () => {},
    });
    const b = await settle.settleApprovalDecision({
      proposalId: p.id,
      decision: 'rejected',
      always: false,
      by: { source: 'desktop' },
      broadcast: () => {},
    });
    expect(a.status).toBe('settled');
    expect(b.status).toBe('already-decided'); // 后到被挡
  });

  it('code 提案 approve→reject（撤队 UX）只落一条存证（首个决定为准，不二次落盘）', async () => {
    // 回归 reviewer 发现的 CRITICAL：code approve 后 forgetDecisionClaim 放开认领支持「approve→排队→拒绝撤队」，
    // 若拒绝重入不加幂等门会二次落盘（approved + rejected 两条卡）。幂等门保证一条提案落一条。
    const p: CodeActionProposal = {
      id: `prop_code_${seq++}`,
      ownerId: 'local-user',
      conversationId: CONV_ID,
      title: '改代码',
      description: '测试',
      createdAt: 1,
      status: 'pending',
      kind: 'code',
      targetProjectId: null,
      risk: 'low',
      rollbackable: true,
      rawPlan: '计划',
    };
    registry.rememberProposal(p);
    await settle.settleApprovalDecision({ proposalId: p.id, decision: 'approved', always: false, by: { source: 'desktop' }, broadcast: () => {} });
    await settle.settleApprovalDecision({ proposalId: p.id, decision: 'rejected', always: false, by: { source: 'desktop' }, broadcast: () => {} });
    await new Promise((r) => setTimeout(r, 30)); // 存证 fire-and-forget
    const history = await convs.readHistory(AGENT_ID, CONV_ID);
    const records = history.filter((m) => m.kind === 'proposal' && m.refId === p.id);
    expect(records).toHaveLength(1); // 只一条
    expect(records[0]!.proposalRecord?.decision).toBe('approved'); // 首个决定为准
  });

  it('渠道投影：决定落定后 refresh 到终态并清表项', async () => {
    const updated: Array<{ decision: string; id: string }> = [];
    proj.registerApprovalProjector('feishu', {
      capability: 'button',
      sendApprovalCard: async () => ({ platformMessageId: 'msg_1' }),
      updateApprovalCardToTerminal: async (_chatId, msgId, decision) => {
        updated.push({ decision, id: msgId });
      },
    });
    const p = bashProposal();
    registry.rememberProposal(p);
    // 先投影一份卡到飞书
    await proj.projectApprovalCard(p.id, [{ platform: 'feishu', chatId: 'oc_x' }], {
      proposalId: p.id,
      title: 't',
      body: 'b',
      buttons: ['allow', 'reject'],
    });
    // 拒绝 → refresh 投影到 rejected
    await settle.settleApprovalDecision({
      proposalId: p.id,
      decision: 'rejected',
      always: false,
      by: { source: 'desktop' },
      broadcast: () => {},
    });
    await new Promise((r) => setTimeout(r, 10)); // recordDecision 是 fire-and-forget
    expect(updated).toEqual([{ decision: 'rejected', id: 'msg_1' }]);
  });
});
