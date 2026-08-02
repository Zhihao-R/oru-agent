/**
 * G104 MCP 探活失败提示 · C1 后拆两半：
 *  - loadMcpPromptIfEnabled 只返回静态规范（自管 + chrome-devtools 指引）——探活状态翻转
 *    （应用启动期 starting → connected）不再击穿第一断点：两轮之间产物逐字节相同。
 *  - buildUnreachableNote 承载运行时的不可达点名（动态层消费）：
 *    ① 任一 enabled server 完全不可达 → 逐个点名 label；reachable 的不点名。
 *    ② probe_failed 不算不可达（工具仍注册、调用返错，让错误说话）。
 *    ③ 全部可达 / 无 enabled server → 返回空串。
 *    ④ disabled server 不参与判定。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { McpServerConfig, McpServerStatus, Settings } from '@shared/types';

const state = vi.hoisted(() => ({
  servers: [] as McpServerConfig[],
  status: {} as Record<string, McpServerStatus>,
}));

vi.mock(
  '../../electron/main/projects/store',
  () =>
    ({
      // 裸 mock；返回值在 beforeEach 用 makeSettings 动态设（工厂内不能 import helper）
      getSettings: vi.fn<() => Promise<Settings>>(),
    }) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>,
);
vi.mock(
  '../../electron/main/mcp/registry',
  () =>
    ({
      getRuntimeState: vi.fn((id: string) =>
        state.status[id]
          ? { serverId: id, status: state.status[id], lastError: 'boom' }
          : undefined,
      ),
    }) satisfies Pick<typeof import('../../electron/main/mcp/registry'), 'getRuntimeState'>,
);

import { loadMcpPromptIfEnabled, buildUnreachableNote } from '../../electron/main/agent/mcpPrompt';
import { getSettings } from '../../electron/main/projects/store';
import { makeSettings } from '../helpers/settings';

function server(id: string, label: string, enabled = true): McpServerConfig {
  return { id, label, command: 'x', args: [], enabled };
}

beforeEach(() => {
  state.servers = [];
  state.status = {};
  // 动态读 state.servers（用例体内会重设）——mockImplementation 每次调用时取当前值
  vi.mocked(getSettings).mockImplementation(async () => makeSettings({ mcpServers: state.servers }));
});

describe('loadMcpPromptIfEnabled 纯静态', () => {
  it('探活状态翻转不改产物：starting → connected 两轮逐字节相同，且不点名任何 server', async () => {
    state.servers = [server('s-flip', '天气服务')];
    state.status = { 's-flip': 'starting' };
    const round1 = await loadMcpPromptIfEnabled();

    state.status = { 's-flip': 'connected' };
    const round2 = await loadMcpPromptIfEnabled();

    expect(round2).toBe(round1);
    expect(round1).not.toContain('天气服务');
    expect(round1).not.toContain('不可用');
  });
});

describe('buildUnreachableNote 运行时点名', () => {
  it('不可达 server 逐个点名，可达的不点名', async () => {
    state.servers = [server('s-down', '天气服务'), server('s-up', '数据库服务')];
    state.status = { 's-down': 'failed', 's-up': 'connected_ready' };

    const out = await buildUnreachableNote();
    expect(out).toContain('天气服务');
    expect(out).not.toContain('数据库服务');
  });

  it('probe_failed 不算不可达（不进提示）', async () => {
    state.servers = [server('s-probe', '探活半通服务')];
    state.status = { 's-probe': 'probe_failed' };

    expect(await buildUnreachableNote()).toBe('');
  });

  it('无 state（还没起来）也算不可达', async () => {
    state.servers = [server('s-new', '刚加的服务')];
    // 不设 status → getRuntimeState 返 undefined

    expect(await buildUnreachableNote()).toContain('刚加的服务');
  });

  it('全部可达 → 空串', async () => {
    state.servers = [server('s-up', '在线服务')];
    state.status = { 's-up': 'connected' };

    expect(await buildUnreachableNote()).toBe('');
  });

  it('disabled server 不参与判定', async () => {
    state.servers = [server('s-off', '停用服务', false)];
    state.status = { 's-off': 'failed' };

    expect(await buildUnreachableNote()).toBe('');
  });
});
