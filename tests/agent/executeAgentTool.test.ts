/**
 * 中央工具分发闸 executeAgentTool 回归（只读重构 · 声明式统一拦截）。
 *
 * 取代「每个写工具 execute 入口手调 readonlyWriteReject」：写工具靠声明位 mutatesEnvironment 标记，
 * 三个 backend 的工具分发都过 executeAgentTool，只读挡 + 标记写 → 在触达 execute 之前直接拒。
 * 锁三件事：① 标记写工具只读下拒、execute 不被调（防真实副作用 + 防回执与卡片割裂）
 *          ② 未标记（读）工具只读下照常放行 ③ 挡位每次调用实时读（中途切只读即时生效）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentTool, ToolContext, ToolResult } from '@shared/agent/backend';
import type { Agent } from '@shared/types';

const state = vi.hoisted(() => ({ mode: 'work' as Agent['approvalMode'] }));
vi.mock('../../electron/main/agent/store/agents', () => ({
  realtimeApprovalModeFor: vi.fn(async (_id: string, fallback: Agent['approvalMode']) => state.mode ?? fallback),
  // 只读拒绝理由（D4 接个体名）用 getAgent——返回 null 即回落物种名 Oru。
  getAgent: vi.fn(async () => null),
}));
// 拒绝理由按 owner 语言取词；固定中文以验「只读」字样（避开 electron app）。
vi.mock('../../electron/main/i18n/effectiveLang', () => ({ resolveEffectiveLang: () => 'zh' }));

import { executeAgentTool } from '../../electron/main/agent/agentTools/approvalGate';
import { makeToolContext } from '../helpers/toolContext';

const ctx = (): ToolContext =>
  makeToolContext({ conversationId: 'c', agentId: 'twin', ownerId: 'local-user' });

function tool(mutatesEnvironment: boolean, onRun: () => void): AgentTool {
  return {
    name: 'demo',
    description: 'd',
    inputSchema: { type: 'object' },
    mutatesEnvironment,
    execute: async (): Promise<ToolResult> => {
      onRun();
      return { text: 'ran' };
    },
  } satisfies AgentTool;
}

describe('executeAgentTool 只读统一闸', () => {
  it('只读挡 + 标记写：返回只读拒绝回执，execute 不被调', async () => {
    state.mode = 'readonly';
    let ran = false;
    const r = await executeAgentTool(tool(true, () => { ran = true; }), {}, ctx());
    expect(ran).toBe(false);
    expect(r.text).toContain('只读');
  });

  it('只读挡 + 未标记（读工具）：照常放行执行', async () => {
    state.mode = 'readonly';
    let ran = false;
    const r = await executeAgentTool(tool(false, () => { ran = true; }), {}, ctx());
    expect(ran).toBe(true);
    expect(r.text).toBe('ran');
  });

  it('工作挡 + 标记写：放行执行（只读才拦）', async () => {
    state.mode = 'work';
    let ran = false;
    const r = await executeAgentTool(tool(true, () => { ran = true; }), {}, ctx());
    expect(ran).toBe(true);
    expect(r.text).toBe('ran');
  });

  it('挡位实时读：同一工具，中途切只读后下一次调用即拦', async () => {
    state.mode = 'work';
    const t = tool(true, () => {});
    expect((await executeAgentTool(t, {}, ctx())).text).toBe('ran');
    state.mode = 'readonly';
    expect((await executeAgentTool(t, {}, ctx())).text).toContain('只读');
  });
});
