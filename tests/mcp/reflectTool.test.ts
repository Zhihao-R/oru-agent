/**
 * MCP 反射工具：中断信号透传 + failed 分支懒重连（技术设计 §4.4）。
 *
 * 锁的目标问题：
 *  ① 用户按 Esc 中断对话时，正在跑的 MCP 调用要能被取消（abortSignal 透传到 callTool）。
 *  ② 运行中崩溃（status=failed）时 execute 触发懒重连；重连成功后**必须打到重连后的新
 *    client 实例**——reflectMcpTool 闭包捕获的是崩溃前的旧 client，restart 已 new 了新实例，
 *    沿用旧引用会永远 failed（CLAUDE.md「await 后重读」在 reflectTool 层的体现）。
 *  ③ 熔断 / 重连失败时返回明确"别重试"文案，不调 callTool。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from '@shared/types';
import type { ToolContext } from '@shared/agent/backend';
import type { McpServerClient } from '../../electron/main/mcp/client';
import type { McpToolMeta } from '../../electron/main/mcp/types';
import type { ReconnectOutcome } from '../../electron/main/mcp/registry';

// reflectTool.execute 按 owner 语言取掉线文案——桩 getSettings 给定语言（值在 beforeEach 用
// makeSettings 设，工厂内不能 import helper，故留裸 mock），i18n 用真 bundled 资源
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

import { getSettings } from '../../electron/main/projects/store';
import { makeSettings } from '../helpers/settings';
import { makeToolContext } from '../helpers/toolContext';
import { reflectMcpTool, type ReflectDeps } from '../../electron/main/mcp/reflectTool';

const ctx = (signal: AbortSignal): ToolContext =>
  makeToolContext({ conversationId: 'c', agentId: 'twin', ownerId: 'local-user', abortSignal: signal });

const tool: McpToolMeta = {
  name: 'do_thing',
  description: 'd',
  inputSchema: { type: 'object' },
};

/** reflectTool 实际访问的 client 成员子集——class 私有字段无法结构化 satisfies，故约束到此最小面。 */
type FakeClient = Pick<McpServerClient, 'config' | 'status' | 'lastError' | 'callTool'>;

function fakeClient(
  status: McpServerClient['status'],
  callTool: McpServerClient['callTool'],
): McpServerClient {
  return {
    config: { id: 'srv', label: 'Srv', command: 'echo', args: [], enabled: true },
    status,
    lastError: undefined,
    callTool,
  } satisfies FakeClient as unknown as McpServerClient;
}

/** 默认 deps：currentClient 回落 undefined（=用闭包捕获的 client），ensureReconnected 不该被调到。 */
function deps(over: Partial<ReflectDeps> = {}): ReflectDeps {
  return {
    ensureReconnected: vi.fn(async () => 'ready' as ReconnectOutcome),
    currentClient: vi.fn(() => undefined),
    ...over,
  } satisfies ReflectDeps;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSettings).mockResolvedValue(makeSettings({ language: 'zh' }));
});

describe('reflectMcpTool — 只读挡拦截前提（S04 · P4 回归钉）', () => {
  it('反射工具声明 mutatesEnvironment=true——只读挡由中央闸 executeAgentTool 统一拒（三后端同口径）', () => {
    const t = reflectMcpTool(fakeClient('ready', vi.fn()), tool, deps());
    expect(t.mutatesEnvironment).toBe(true);
  });
});

describe('reflectMcpTool — 中断信号', () => {
  it('把 ctx.abortSignal 透传给 client.callTool', async () => {
    const seen: { signal?: AbortSignal } = {};
    const callTool = vi.fn(async (_n: string, _a: unknown, signal?: AbortSignal) => {
      seen.signal = signal;
      return { text: 'ok', isError: false };
    }) as unknown as McpServerClient['callTool'];
    const client = fakeClient('connected_ready', callTool);

    const ac = new AbortController();
    const reflected = reflectMcpTool(client, tool, deps({ currentClient: () => client }));
    await reflected.execute({ a: 1 }, ctx(ac.signal));

    expect(seen.signal).toBe(ac.signal);
  });

  it('abort 时返回中性"已取消"，不报为失败', async () => {
    const callTool = vi.fn(async () => {
      throw new Error('The operation was aborted');
    }) as unknown as McpServerClient['callTool'];
    const client = fakeClient('connected_ready', callTool);

    const ac = new AbortController();
    ac.abort();
    const reflected = reflectMcpTool(client, tool, deps({ currentClient: () => client }));
    const r = await reflected.execute({ a: 1 }, ctx(ac.signal));

    expect(r.text).not.toContain('失败');
    expect(r.text).toContain('取消');
  });
});

describe('reflectMcpTool — failed 分支懒重连（§4.4）', () => {
  it('运行中崩溃 → 重连成功 → 打到重连后的【新】client 实例，不是闭包里的旧 client', async () => {
    // 闭包捕获的旧 client：崩溃后永远 failed，若误用它 callTool 会走 notReady 文案
    const oldCallTool = vi.fn(async () => ({ text: 'STALE', isError: false }));
    const oldClient = fakeClient('failed', oldCallTool as unknown as McpServerClient['callTool']);

    // 重连后 registry 里的新 client：connected_ready，callTool 返回真结果
    const newCallTool = vi.fn(async () => ({ text: 'FRESH', isError: false }));
    const newClient = fakeClient('connected_ready', newCallTool as unknown as McpServerClient['callTool']);

    // ensureReconnected 把 currentClient 从旧切到新（模拟 restart 换实例）
    let current = oldClient;
    const ensureReconnected = vi.fn(async () => {
      current = newClient;
      return 'ready' as ReconnectOutcome;
    });
    const reflected = reflectMcpTool(
      oldClient,
      tool,
      deps({ ensureReconnected, currentClient: () => current }),
    );

    const ac = new AbortController();
    const r = await reflected.execute({ a: 1 }, ctx(ac.signal));

    expect(ensureReconnected).toHaveBeenCalledWith('srv');
    expect(newCallTool).toHaveBeenCalledTimes(1); // 打到新 client
    expect(oldCallTool).not.toHaveBeenCalled(); // 旧闭包 client 没被调
    // 回执现在按来源框定（第三方 server 的返回是外部内容），原文在框定之后
    expect(r.text).toContain('FRESH');
  });

  it('熔断 → 返回"别重试"文案，不调 callTool', async () => {
    const callTool = vi.fn(async () => ({ text: 'x', isError: false }));
    const client = fakeClient('failed', callTool as unknown as McpServerClient['callTool']);
    const reflected = reflectMcpTool(
      client,
      tool,
      deps({
        ensureReconnected: vi.fn(async () => 'circuit_open' as ReconnectOutcome),
        currentClient: () => client,
      }),
    );

    const r = await reflected.execute({ a: 1 }, ctx(new AbortController().signal));

    expect(callTool).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('手动重连'); // circuitOpen 文案（zh）
  });

  it('重连失败 → 返回"稍后再试"文案，不调 callTool', async () => {
    const callTool = vi.fn(async () => ({ text: 'x', isError: false }));
    const client = fakeClient('failed', callTool as unknown as McpServerClient['callTool']);
    const reflected = reflectMcpTool(
      client,
      tool,
      deps({
        ensureReconnected: vi.fn(async () => 'reconnect_failed' as ReconnectOutcome),
        currentClient: () => client,
      }),
    );

    const r = await reflected.execute({ a: 1 }, ctx(new AbortController().signal));

    expect(callTool).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('稍后会再试');
  });

  it('probe_failed → 维持现状（明确文案），不触发重连', async () => {
    const ensureReconnected = vi.fn(async () => 'ready' as ReconnectOutcome);
    const client = fakeClient('probe_failed', vi.fn() as unknown as McpServerClient['callTool']);
    const reflected = reflectMcpTool(client, tool, deps({ ensureReconnected, currentClient: () => client }));

    const r = await reflected.execute({ a: 1 }, ctx(new AbortController().signal));

    expect(ensureReconnected).not.toHaveBeenCalled();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('探活'); // probeFailed 文案
  });
});

/**
 * 回执框定与图片归一（2026-07-28）。锁的目标问题：第三方 server 的返回是外部内容
 * （chrome-devtools 回的就是网页原文），不框定的话 server 能在自己的文字里伪造系统口吻的旁白，
 * 而这批改动恰恰开始往这段文字里追加 Oru 自己的说明（图片降级、归一失败），两种声音必须可分辨。
 */
describe('reflectMcpTool — 回执框定', () => {
  it('成功回执按来源框定，原文完整保留在框定之后', async () => {
    const callTool = vi.fn(async () => ({ text: '页面正文', isError: false }));
    const client = fakeClient('connected_ready', callTool as unknown as McpServerClient['callTool']);
    const reflected = reflectMcpTool(client, tool, deps({ currentClient: () => client }));

    const r = await reflected.execute({}, ctx(new AbortController().signal));

    expect(r.text).toContain('页面正文');
    expect(r.text.indexOf('页面正文')).toBeGreaterThan(0); // 前面有框定标题
    expect(r.isError).toBe(false);
  });

  it('错误回执不框定（那是 Oru 自己的诊断文案，不是外部内容）', async () => {
    const callTool = vi.fn(async () => ({ text: 'server 说失败了', isError: true }));
    const client = fakeClient('connected_ready', callTool as unknown as McpServerClient['callTool']);
    const reflected = reflectMcpTool(client, tool, deps({ currentClient: () => client }));

    const r = await reflected.execute({}, ctx(new AbortController().signal));

    expect(r.text).toBe('server 说失败了');
  });
});
