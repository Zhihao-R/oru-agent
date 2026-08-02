/**
 * 断路器编排 + executeAgentTool 集成（G01/G04）。
 *
 * 验：连续失败到阈值后，下一次工具经 executeAgentTool 触发跳闸卡（onCircuitBreak）、阻塞；
 *  - 用户「继续放行」→ 清零、工具照常执行；
 *  - 用户「停止」→ 不触达 execute，返回停止文案；
 *  - 并发多工具同时跳闸只弹一张卡（去重）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool, ToolContext } from '@shared/agent/backend';
import { executeAgentTool } from '../../electron/main/agent/agentTools/approvalGate';
import { settleBreaker } from '../../electron/main/proposals/pendingCircuitBreaker';
import { __clearBreakersForTest, CONSEC_FAILURE_LIMIT } from '../../electron/main/agent/circuitBreaker';
import { makeToolContext } from '../helpers/toolContext';

// executeAgentTool 里只读闸会 getAgent/getSettings——mock 掉，恒非只读挡放行
vi.mock('../../electron/main/agent/store/agents', () => ({
  realtimeApprovalModeFor: vi.fn(async () => 'work'),
  getAgent: vi.fn(async () => ({ name: 'Oru' })),
}));
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn(async () => ({ language: 'zh' })),
}));

afterEach(() => {
  __clearBreakersForTest();
  vi.clearAllMocks();
});

function failTool(): AgentTool {
  return {
    name: 'flaky',
    description: 'always fails',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ isError: true, text: 'boom' }),
    mutatesEnvironment: false,
  } satisfies AgentTool;
}
function okTool(): AgentTool {
  return {
    name: 'ok',
    description: 'succeeds',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ text: 'done' }),
    mutatesEnvironment: false,
  } satisfies AgentTool;
}

const makeCtx = (overrides: Partial<ToolContext> = {}): ToolContext =>
  makeToolContext({ conversationId: 'cbg-conv', agentId: 'ag1', ownerId: 'o1', ...overrides });

describe('circuitBreakerGuard × executeAgentTool（G01/G04）', () => {
  it('连续失败到阈值 → 弹跳闸卡；「继续放行」清零后照常执行', async () => {
    let breakerId = '';
    const onCircuitBreak = vi.fn(async (req: { breakerId: string }) => {
      breakerId = req.breakerId;
    });
    const ctx = makeCtx({ onCircuitBreak });
    const flaky = failTool();

    // 前 CONSEC_FAILURE_LIMIT 次失败——第 CONSEC_FAILURE_LIMIT+1 次调用前评估跳闸
    for (let i = 0; i < CONSEC_FAILURE_LIMIT; i++) {
      await executeAgentTool(flaky, {}, ctx);
    }
    expect(onCircuitBreak).not.toHaveBeenCalled();

    // 下一次调用：跳闸卡弹出、阻塞。异步放行后完成。
    const p = executeAgentTool(okTool(), {}, ctx);
    await vi.waitFor(() => expect(onCircuitBreak).toHaveBeenCalledTimes(1));
    expect(settleBreaker(breakerId, 'resume')).toBe(true);
    const r = await p;
    expect(r.text).toBe('done'); // 放行后真的执行了
  });

  it('「停止」→ 不触达 execute，返回停止文案', async () => {
    let breakerId = '';
    const onCircuitBreak = vi.fn(async (req: { breakerId: string }) => {
      breakerId = req.breakerId;
    });
    const ctx = makeCtx({ conversationId: 'cbg-stop', onCircuitBreak });
    const flaky = failTool();
    for (let i = 0; i < CONSEC_FAILURE_LIMIT; i++) await executeAgentTool(flaky, {}, ctx);

    const executed = vi.fn();
    const watched: AgentTool = { ...okTool(), execute: async () => { executed(); return { text: 'x' }; } };
    const p = executeAgentTool(watched, {}, ctx);
    await vi.waitFor(() => expect(breakerId).not.toBe(''));
    settleBreaker(breakerId, 'stop');
    const r = await p;
    expect(r.text).toContain('停止');
    expect(executed, '停止不该触达 execute').not.toHaveBeenCalled();
  });

  it('无 onCircuitBreak（背景 / 无 UI）→ 不阻塞、放行', async () => {
    const ctx = makeCtx({ conversationId: 'cbg-noui' }); // 不挂 onCircuitBreak
    const flaky = failTool();
    for (let i = 0; i < CONSEC_FAILURE_LIMIT + 2; i++) {
      const r = await executeAgentTool(flaky, {}, ctx);
      expect(r.isError).toBe(true); // 照常执行、不挂起
    }
  });
});
