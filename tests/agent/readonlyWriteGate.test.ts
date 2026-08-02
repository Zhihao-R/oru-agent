/**
 * 只读挡 SDK 写工具闸（PreToolUse）回归（只读重构 · playtest 补缺口）。
 *
 * 后台 subagent / 对话分身用 SDK 内置 Write/Edit 改文件，这条路不经 Oru 提案闸、permissionMode:'bypass'
 * 又旁路了 disallowedTools。makeReadonlyWriteGate 在只读挡下对这些工具回 deny（PreToolUse 在权限层之前
 * 生效，故 bypass 无效化它）。真机 playtest 已确认 hello.txt 在只读挡下写不出来；本测试锁住判定逻辑。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from '@shared/agent/backend';
import type { Agent } from '@shared/types';
import { makeToolContext } from '../helpers/toolContext';

const state = vi.hoisted(() => ({ mode: 'work' as Agent['approvalMode'] }));
vi.mock('../../electron/main/agent/store/agents', () => ({
  // 闸门用 realtimeApprovalModeFor；拒绝理由（D4 接个体名）用 getAgent——返回 null 即回落物种名 Oru。
  realtimeApprovalModeFor: vi.fn(async (_id: string, fallback: Agent['approvalMode']) => state.mode ?? fallback),
  getAgent: vi.fn(async () => null),
}));
// 拒绝理由按 owner 语言取词；固定中文以验「只读」字样（避开 electron app）。
vi.mock('../../electron/main/i18n/effectiveLang', () => ({ resolveEffectiveLang: () => 'zh' }));

import { makeReadonlyWriteGate } from '../../electron/main/agent/backends/claudeCode';

function ctx(): ToolContext {
  return makeToolContext({
    conversationId: 'c',
    agentId: 'twin',
    ownerId: 'local-user',
    usage: 'subagentCoder',
  });
}

describe('makeReadonlyWriteGate', () => {
  it('只读挡：SDK 写工具 + Bash 一律 deny', async () => {
    state.mode = 'readonly';
    const gate = makeReadonlyWriteGate(ctx());
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      const r = await gate(t);
      expect(r?.deny).toBe(true);
      expect(r?.reason).toContain('只读');
    }
  });

  it('只读挡：外部 MCP 工具（非 mcp__oru__）fail-closed 一律 deny', async () => {
    state.mode = 'readonly';
    const gate = makeReadonlyWriteGate(ctx());
    for (const t of ['mcp__filesystem__write_file', 'mcp__git__commit', 'mcp__chrome-devtools__navigate_page']) {
      expect((await gate(t))?.deny).toBe(true);
    }
  });

  it('只读挡：外部 MCP 反射工具的双前缀 wire 名同样 deny（外层 mcp__oru__ 不得让它冒充自有工具）', async () => {
    // 2026-07-27 外部 MCP 改走反射后，桥进 'oru' 的工具到闸门时名字是
    // mcp__oru__mcp__<serverId>__<tool>。判定若不先归一，会因外层前缀把它当成 Oru 自有工具放行——
    // 这正是「前缀致精确匹配静默失效、单元测假绿」踩过的形态，故按生产实际的 wire 名钉死。
    state.mode = 'readonly';
    const gate = makeReadonlyWriteGate(ctx());
    for (const t of [
      'mcp__oru__mcp__chrome-devtools__navigate_page',
      'mcp__oru__mcp__filesystem__write_file',
    ]) {
      const r = await gate(t);
      expect(r?.deny).toBe(true);
      expect(r?.reason).toContain('只读');
    }
  });

  it('只读挡：SDK 读工具 + Oru 自有工具（自走提案闸）放行，不在此重复拦', async () => {
    state.mode = 'readonly';
    const gate = makeReadonlyWriteGate(ctx());
    for (const t of ['Read', 'Glob', 'Grep', 'mcp__oru__bash', 'mcp__oru__read_file', 'mcp__oru__write_file']) {
      expect(await gate(t)).toBeUndefined();
    }
  });

  it('工作 / 危险挡：SDK 写工具 + 外部 MCP 全放行（只读才拦）', async () => {
    for (const mode of ['work', 'danger'] as const) {
      state.mode = mode;
      const gate = makeReadonlyWriteGate(ctx());
      expect(await gate('Write')).toBeUndefined();
      expect(await gate('Bash')).toBeUndefined();
      expect(await gate('mcp__filesystem__write_file')).toBeUndefined();
    }
  });

  it('挡位每次调用实时读：同一闸门，挡位中途切只读后下一次调用即拦', async () => {
    state.mode = 'work';
    const gate = makeReadonlyWriteGate(ctx());
    expect(await gate('Write')).toBeUndefined(); // work：放行
    state.mode = 'readonly'; // 用户中途收紧
    expect((await gate('Write'))?.deny).toBe(true); // 同一闸门，立即拦
  });
});
