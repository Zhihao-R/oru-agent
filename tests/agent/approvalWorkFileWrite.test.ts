/**
 * PT-004 回归：工作（work）挡下文件写操作的审批门控。
 *
 * 设置页对 work 挡的承诺是"放手干，只在删除 / 覆盖时问"。修复前 file.write 的 proposal 不设
 * forceApproval，emitProposal 在 work 挡（forceApproval!==true）直接执行——覆盖/删除静默落盘，违背承诺。
 *
 * 验：work 挡下
 *   - 覆盖已存在文件（overwrite）/ 删除（delete）→ forceApproval 真 → 弹审批卡（onProposal 被调），确认前不执行；
 *   - 新建（create）/ 增量编辑（edit）→ forceApproval 假 → 直接执行、不弹卡（edit 有实时保存+历史兜底，是日常主力）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@shared/types';
import type { ToolContext, ToolResult } from '@shared/agent/backend';

const state = vi.hoisted(() => ({
  mode: 'work' as Agent['approvalMode'],
  // 收紧覆盖（2026-07-31 双向开关）：被拨成「每次问」的行 id 集
  askRows: new Set<string>(),
}));
vi.mock('../../electron/main/i18n/effectiveLang', () => ({ resolveEffectiveLang: () => 'zh' }));
// 收紧覆盖 store mock：读预置集合（隔离真实 ~/.oru，行为靠显式设置）。satisfies 约束到真实接口。
vi.mock('../../electron/main/proposals/behaviorPolicy/store', () => {
  return {
    isAskOverridden: async (rowId: string): Promise<boolean> => state.askRows.has(rowId),
    setAskOverridden: async () => ({ persisted: true }),
    listAskOverrides: async () => [...state.askRows],
    isAskableRow: (rowId: string) => ['create', 'modify', 'aiOwned'].includes(rowId),
    __resetBehaviorPolicyCacheForTest: () => {},
  } satisfies typeof import('../../electron/main/proposals/behaviorPolicy/store');
});
vi.mock('../../electron/main/agent/store/agents', () => {
  const getAgent = vi.fn(
    async (id: string): Promise<Agent> => ({
      id,
      ownerId: 'local-user',
      name: 'Twin',
      homePath: '/tmp/h',
      systemPromptAppend: null,
      approvalMode: state.mode,
      createdAt: 0,
      avatarPath: null,
    }),
  );
  const realtimeApprovalModeFor = async (
    agentId: string,
    fallback: Agent['approvalMode'],
  ): Promise<Agent['approvalMode']> => {
    try {
      return (await getAgent(agentId)).approvalMode;
    } catch {
      return fallback;
    }
  };
  return { getAgent, realtimeApprovalModeFor };
});

import { proposeOrExecute } from '../../electron/main/agent/agentTools/emitProposal';
import { buildFileWriteProposal } from '../../electron/main/proposals/makeFileWriteProposal';
import { makeToolContext } from '../helpers/toolContext';

const makeCtx = (overrides?: Partial<ToolContext>): ToolContext =>
  makeToolContext({ conversationId: 'conv_1', agentId: 'twin', ownerId: 'local-user', ...overrides });

beforeEach(() => {
  state.mode = 'work';
  state.askRows.clear();
});

describe('buildFileWriteProposal · forceApproval 仅覆盖/删除', () => {
  const force = (mode: 'create' | 'overwrite' | 'edit' | 'delete'): boolean | undefined =>
    buildFileWriteProposal({ conversationId: 'conv_1', path: '/tmp/x.md', mode }).forceApproval;

  it('delete / overwrite 置 true，create / edit 置 false', () => {
    expect(force('delete')).toBe(true);
    expect(force('overwrite')).toBe(true);
    expect(force('create')).toBe(false);
    expect(force('edit')).toBe(false);
  });
});

describe('work 挡 · file.write 审批门控（PT-004）', () => {
  it('覆盖已存在文件 → 弹审批卡、确认前不执行', async () => {
    const ac = new AbortController();
    let executed = false;
    // 卡片弹出即模拟用户取消（abort），让同步等待解开，证明走了审批路径而非直接执行。
    const onProposal = vi.fn(async () => ac.abort());
    const r = await proposeOrExecute(
      makeCtx({ onProposal, abortSignal: ac.signal }),
      buildFileWriteProposal({ conversationId: 'conv_1', path: '/tmp/x.md', mode: 'overwrite', content: 'hi' }),
      {
        approvalText: '请确认覆盖',
        execute: async (): Promise<ToolResult> => {
          executed = true;
          return { text: 'ran' };
        },
      },
    );
    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(executed).toBe(false);
    expect(r.text).toContain('取消');
  });

  it('删除 → 弹审批卡、确认前不执行', async () => {
    const ac = new AbortController();
    let executed = false;
    const onProposal = vi.fn(async () => ac.abort());
    const r = await proposeOrExecute(
      makeCtx({ onProposal, abortSignal: ac.signal }),
      buildFileWriteProposal({ conversationId: 'conv_1', path: '/tmp/x.md', mode: 'delete' }),
      {
        approvalText: '请确认删除',
        execute: async (): Promise<ToolResult> => {
          executed = true;
          return { text: 'ran' };
        },
      },
    );
    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(executed).toBe(false);
  });

  it('新建 / 增量编辑 → 直接执行、不弹卡', async () => {
    for (const mode of ['create', 'edit'] as const) {
      const onProposal = vi.fn(async () => {});
      let executed = false;
      const r = await proposeOrExecute(
        makeCtx({ onProposal }),
        buildFileWriteProposal({ conversationId: 'conv_1', path: '/tmp/x.md', mode, content: 'hi' }),
        {
          approvalText: 'x',
          execute: async (): Promise<ToolResult> => {
            executed = true;
            return { text: 'ran' };
          },
        },
      );
      expect(onProposal, `mode=${mode} 不该弹卡`).not.toHaveBeenCalled();
      expect(executed, `mode=${mode} 该直接执行`).toBe(true);
      expect(r.text).toBe('ran');
    }
  });
});

describe('收紧覆盖（2026-07-31 策略表双向开关）：默认不问的行拨成「每次问」', () => {
  it('create 被拨成每次问 → 工作挡弹卡、确认前不执行', async () => {
    state.askRows.add('create');
    const ac = new AbortController();
    let executed = false;
    const onProposal = vi.fn(async () => ac.abort());
    const r = await proposeOrExecute(
      makeCtx({ onProposal, abortSignal: ac.signal }),
      buildFileWriteProposal({ conversationId: 'conv_1', path: '/tmp/x.md', mode: 'create', content: 'hi' }),
      {
        approvalText: '请确认新建',
        execute: async (): Promise<ToolResult> => {
          executed = true;
          return { text: 'ran' };
        },
      },
    );
    expect(onProposal).toHaveBeenCalledTimes(1);
    expect(executed).toBe(false);
    expect(r.text).toContain('取消');
  });

  it('modify 被拨成每次问 → 增量编辑也弹卡', async () => {
    state.askRows.add('modify');
    const ac = new AbortController();
    const onProposal = vi.fn(async () => ac.abort());
    await proposeOrExecute(
      makeCtx({ onProposal, abortSignal: ac.signal }),
      buildFileWriteProposal({ conversationId: 'conv_1', path: '/tmp/x.md', mode: 'edit', content: 'hi' }),
      { approvalText: 'x', execute: async (): Promise<ToolResult> => ({ text: 'ran' }) },
    );
    expect(onProposal).toHaveBeenCalledTimes(1);
  });

  it('未拨的行不受影响（只拨 create 时 modify 仍直执行）', async () => {
    state.askRows.add('create');
    const onProposal = vi.fn(async () => {});
    let executed = false;
    await proposeOrExecute(
      makeCtx({ onProposal }),
      buildFileWriteProposal({ conversationId: 'conv_1', path: '/tmp/x.md', mode: 'edit', content: 'hi' }),
      {
        approvalText: 'x',
        execute: async (): Promise<ToolResult> => {
          executed = true;
          return { text: 'ran' };
        },
      },
    );
    expect(onProposal).not.toHaveBeenCalled();
    expect(executed).toBe(true);
  });

  it('危险挡不看收紧覆盖（策略表是工作挡概念）→ create 被拨成问仍直执行', async () => {
    state.mode = 'danger';
    state.askRows.add('create');
    const onProposal = vi.fn(async () => {});
    let executed = false;
    await proposeOrExecute(
      makeCtx({ onProposal }),
      buildFileWriteProposal({ conversationId: 'conv_1', path: '/tmp/x.md', mode: 'create', content: 'hi' }),
      {
        approvalText: 'x',
        execute: async (): Promise<ToolResult> => {
          executed = true;
          return { text: 'ran' };
        },
      },
    );
    expect(onProposal).not.toHaveBeenCalled();
    expect(executed).toBe(true);
  });
});
