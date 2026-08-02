/**
 * write_file · aiOwned 收紧覆盖（2026-07-31 策略表双向开关）。
 *
 * 目标行为：D3 免审默认开——磁盘仍是 AI 整篇产出（用户未动）时，整篇覆盖视同 create 不弹卡；
 * 用户把「覆盖 Oru 自己的产出」拨成「每次问」后，这道免审关闭，覆盖 AI 自产文件也弹卡。
 * 用真实 behaviorPolicy store（ORU_DIR 重定向隔离）验证 writeFile 挂点真的消费覆盖。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, ActionProposal } from '@shared/types';
import type { ToolResult } from '@shared/agent/backend';

const H = vi.hoisted(() => {
  // hoisted 早于所有 import 执行，这里不能用 node:path/os——手拼一个 tmp 路径
  const dir = `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/oru-test-aiowned-${Date.now()}`;
  process.env.ORU_DIR = dir;
  return { dir };
});

vi.mock('../../electron/main/agent/agentTools/pathSandbox', () => ({
  assertWritableSandbox: async () => {},
  SandboxError: class SandboxError extends Error {},
}));
vi.mock('../../electron/main/fs/fsChanged', () => ({ broadcastFileChanged: async () => {} }));
vi.mock('../../electron/main/i18n/effectiveLang', () => ({ resolveEffectiveLang: () => 'zh' }));
vi.mock('../../electron/main/agent/store/agents', () => ({
  getAgent: async (id: string): Promise<Agent> => ({
    id,
    ownerId: 'local-user',
    name: 'Oru',
    homePath: '/tmp/h',
    systemPromptAppend: null,
    approvalMode: 'work',
    createdAt: 0,
    avatarPath: null,
  }),
  realtimeApprovalModeFor: async (): Promise<Agent['approvalMode']> => 'work',
}));

let makeWriteFileTool!: typeof import('../../electron/main/agent/agentTools/writeFile').makeWriteFileTool;
let clearConvFileState!: typeof import('../../electron/main/agent/conversationFileState').clearConvFileState;
let policyStore!: typeof import('../../electron/main/proposals/behaviorPolicy/store');

const WORK = join(H.dir, 'work');
const P = join(WORK, 'artifact.md');

beforeAll(async () => {
  await fs.mkdir(WORK, { recursive: true });
  ({ makeWriteFileTool } = await import('../../electron/main/agent/agentTools/writeFile'));
  ({ clearConvFileState } = await import('../../electron/main/agent/conversationFileState'));
  policyStore = await import('../../electron/main/proposals/behaviorPolicy/store');
});

afterAll(async () => {
  await fs.rm(H.dir, { recursive: true, force: true });
});

beforeEach(async () => {
  clearConvFileState('conv_1'); // 每例都从「这个对话没碰过任何文件」起步
  await fs.rm(P, { force: true });
  // 收紧覆盖归零：直接删文件 + 清缓存（比逐行 setAsk(false) 更彻底）
  await fs.rm(join(H.dir, 'users', 'local-user', 'behavior-policy.json'), { force: true });
  policyStore.__resetBehaviorPolicyCacheForTest();
});

const write = async (
  content: string,
  onProposal?: (p: ActionProposal) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<ToolResult> => {
  const { makeToolContext } = await import('../helpers/toolContext');
  return makeWriteFileTool().execute(
    { path: P, content },
    makeToolContext({ conversationId: 'conv_1', onProposal, abortSignal }),
  );
};

describe('write_file · aiOwned 收紧覆盖', () => {
  it('默认：覆盖自己整篇产出（用户未动）→ D3 免审，不弹卡直执行', async () => {
    await write('v1'); // create：建立 D3 凭据
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = await write('v2', onProposal);
    expect(onProposal).not.toHaveBeenCalled();
    expect(r.isError).toBeFalsy();
    expect(readFileSync(P, 'utf-8')).toBe('v2');
  });

  it('拨成「每次问」后：同样的覆盖弹卡、取消不落盘', async () => {
    await write('v1');
    await policyStore.setAskOverridden('aiOwned', true);
    const ac = new AbortController();
    const onProposal = vi.fn(async (_p: ActionProposal) => ac.abort());
    const r = await write('v2', onProposal, ac.signal);
    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(r.text).toContain('取消');
    expect(readFileSync(P, 'utf-8')).toBe('v1'); // 取消不落盘
  });

  it('拨回默认后：D3 免审恢复，覆盖自产文件又不弹卡', async () => {
    await write('v1');
    await policyStore.setAskOverridden('aiOwned', true);
    await policyStore.setAskOverridden('aiOwned', false);
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = await write('v2', onProposal);
    expect(onProposal).not.toHaveBeenCalled();
    expect(r.isError).toBeFalsy();
    expect(readFileSync(P, 'utf-8')).toBe('v2');
  });
});
