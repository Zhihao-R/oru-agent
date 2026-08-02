/**
 * plugin/skill/deck 类提案「执行窗口内拒绝不生效」回归——2026-07-06 审计暗角 1。
 *
 * 病灶：A2 只对 mcp.* 三 kind 迁 executing；plugin/skill/deck 执行期仍停 pending，
 * 插件下载安装的数秒窗口内点拒绝会落 rejected，而执行器已把环境改完——用户看到「已拒绝」、
 * 插件实际装上了（finalize 遇 rejected throw 被 catch 的 console.warn 吞掉）。
 * 防线：独立执行器开跑对所有 kind 统一迁 executing，reject 被 handler 的非 pending 挡住。
 *
 * plugin.install 作代表（skill/deck 同经独立执行器同一迁移点）。经真实 handler 驱动。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginInstallProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { ErrorCodes } from '@shared/types';

// maybeResumeTurn 会经 listAgents → 真实 store / LLM——掐掉，其余符号保留真实实现（共享 proposals Map）。
vi.mock('../../electron/main/ws/handlers/resumeTurn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/ws/handlers/resumeTurn')>();
  return {
    ...actual,
    maybeResumeTurn: vi.fn(async () => {}) satisfies typeof actual.maybeResumeTurn,
  };
});

// 拒绝路径的系统记会 appendMessage 到真实用户目录——掐掉
vi.mock('../../electron/main/proposals/systemEvent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/proposals/systemEvent')>();
  return {
    ...actual,
    writeRejectionSystemEvent: vi.fn(
      async () => {},
    ) satisfies typeof actual.writeRejectionSystemEvent,
  };
});

// perform 内 getSettings().catch(() => null)——抛错走 catch 回落默认语言，避免读真实 ~/.oru
vi.mock('../../electron/main/projects/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/projects/store')>();
  const getSettings = vi.fn(async () => {
    throw new Error('测试环境无 settings');
  }) satisfies typeof actual.getSettings;
  return { ...actual, getSettings };
});

// plugin installer：performPluginInstall 用可控闸门模拟数秒安装窗口。它是纯执行——
// 不碰 status、不发 chip，终态由独立执行器在它返回后统一迁。
const { installMock, releaseInstall } = vi.hoisted(() => {
  let release: () => void = () => {};
  const mock = vi.fn(async () => {
    await new Promise<void>((r) => (release = r));
    return { pluginId: 'demo', name: 'demo', warnings: [] };
  });
  return { installMock: mock, releaseInstall: () => release() };
});
vi.mock('../../electron/main/plugins/installer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/plugins/installer')>();
  return {
    ...actual,
    performPluginInstall: installMock satisfies typeof actual.performPluginInstall,
  };
});

// chip 落对话流会写真实 ~/.oru——本文件只验状态机时序，掐掉。
vi.mock('../../electron/main/proposals/outcomeChip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/proposals/outcomeChip')>();
  return {
    ...actual,
    writeProposalOutcomeChip: vi.fn(async () => {}) satisfies typeof actual.writeProposalOutcomeChip,
  };
});

import { proposalTaskHandlers } from '../../electron/main/ws/handlers/proposals';
import { rememberProposal } from '../../electron/main/proposals/registry';
import type { Reply } from '../../electron/main/ws/server';

let seq = 0;
function makePluginInstall(): PluginInstallProposal {
  return {
    id: `prop_plugin_${seq++}`,
    ownerId: 'local-user',
    conversationId: 'conv_plugin',
    title: '安装 plugin',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    kind: 'plugin.install',
    pluginManifest: { name: 'demo', description: '演示插件' },
    source: { type: 'github', url: 'https://example.com/demo', commit: 'abc' },
    containedSkills: [],
    containedMcpServers: [],
    containsExecutableScripts: false,
    ignoredSections: [],
  } satisfies PluginInstallProposal;
}

function harness() {
  const events: ServerEvent[] = [];
  const replies: Array<{ reqId: string; type: string; code?: string }> = [];
  const broadcast = (ev: ServerEvent) => {
    events.push(ev);
  };
  const reply: Reply = (reqId, ev) => {
    replies.push({ reqId, type: ev.type, code: (ev as { code?: string }).code });
  };
  const statuses = () =>
    events
      .filter((e) => e.type === 'proposal.statusChanged')
      .map((e) => (e as { status: string }).status);
  return { events, replies, broadcast, reply, statuses };
}

beforeEach(() => {
  installMock.mockClear();
});

describe('plugin 提案：执行窗口内拒绝不生效（暗角 1）', () => {
  it('execute 开跑即迁 executing；执行中 reject 报错不生效；最终 executed 恰一次', async () => {
    const p = makePluginInstall();
    rememberProposal(p);
    const h = harness();

    await proposalTaskHandlers['proposal.execute']!(
      { type: 'proposal.execute', reqId: 'r1', proposalId: p.id },
      { reply: h.reply, broadcast: h.broadcast },
    );
    // 独立执行器是 void 起跑——轮询等它跨过 import 让出点，抵达 perform 闸门。
    // 用 waitFor 而非固定 tick：并行跑测试负载下固定延时会偶发不足（perform 尚未被调用）。
    await vi.waitFor(() => expect(installMock).toHaveBeenCalledTimes(1));

    // 执行已开始（performPluginInstall 卡在闸门里）：状态必须已占住 executing
    expect(p.status).toBe('executing');

    // 执行中点拒绝：不得生效，如实报错——不 ack 假装成功
    await proposalTaskHandlers['proposal.reject']!(
      { type: 'proposal.reject', reqId: 'r2', proposalId: p.id },
      { reply: h.reply, broadcast: h.broadcast },
    );
    expect(p.status).toBe('executing');
    const rejectReply = h.replies.find((r) => r.reqId === 'r2');
    expect(rejectReply?.type).toBe('error');
    expect(rejectReply?.code).toBe(ErrorCodes.TASK_BUSY);

    releaseInstall();
    await vi.waitFor(() => expect(p.status).toBe('executed'));
    // 全程恰好安装一次，广播时序 executing → executed，中间没有 rejected
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(h.statuses()).toEqual(['executing', 'executed']);
  });
});
