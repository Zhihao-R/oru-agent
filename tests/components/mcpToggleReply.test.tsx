/**
 * McpToggle 消费 mcp.update reply（打磨 7）：
 * - ok:true 且带 status → upsertRuntime 落定（曾整个丢弃，状态行永挂「正在启动…」）；
 * - reply ok:false → 回滚乐观 settings（曾不回滚，开关与真值背离）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));
// toastError 真实实现会起定时器，掐掉只记录
vi.mock('@/lib/toast', () => ({ toastError: vi.fn() }));

import { McpToggle } from '@/components/settings/extensions/McpToggle';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMcpRuntimeStore } from '@/stores/mcpRuntimeStore';
import type { McpServerConfig } from '@shared/types';

const SERVER: McpServerConfig = {
  id: 'srv1',
  label: '测试服务',
  command: 'npx',
  args: ['x'],
  enabled: false,
} satisfies McpServerConfig;

afterEach(cleanup);
beforeEach(() => {
  requestMock.mockReset();
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, mcpServers: [SERVER] },
  });
  useMcpRuntimeStore.setState({ byId: {}, loaded: true });
});

function reply(payload: Extract<ServerEventPayload, { type: 'mcp.update.result' }>): void {
  requestMock.mockResolvedValue(payload);
}

describe('McpToggle · 消费 reply 落定（打磨 7）', () => {
  it('off→on + reply ok status connected_ready → 状态从 starting 落定 connected_ready · 13 工具', async () => {
    reply({ type: 'mcp.update.result', serverId: 'srv1', ok: true, status: 'connected_ready', toolCount: 13 });
    render(<McpToggle serverId="srv1" enabled={false} />);
    fireEvent.click(screen.getByRole('switch'));

    // 乐观中间态先进 starting
    expect(useMcpRuntimeStore.getState().byId['srv1']?.status).toBe('starting');
    await waitFor(() => {
      expect(useMcpRuntimeStore.getState().byId['srv1']?.status).toBe('connected_ready');
    });
    expect(useMcpRuntimeStore.getState().byId['srv1']?.toolCount).toBe(13);
    // settings 乐观置 enabled 不回滚
    expect(useSettingsStore.getState().settings.mcpServers?.[0]?.enabled).toBe(true);
  });

  it('reply ok:false → 回滚乐观 settings + spawning 清回 idle', async () => {
    reply({ type: 'mcp.update.result', serverId: 'srv1', ok: false, message: '启动失败' });
    render(<McpToggle serverId="srv1" enabled={false} />);
    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.mcpServers?.[0]?.enabled).toBe(false);
    });
    expect(useMcpRuntimeStore.getState().byId['srv1']?.status).toBe('idle');
  });

  it('reply ok status failed（带 message）→ 落定 failed 态而不是卡在 starting', async () => {
    reply({ type: 'mcp.update.result', serverId: 'srv1', ok: true, status: 'failed', message: 'spawn ENOENT' });
    render(<McpToggle serverId="srv1" enabled={false} />);
    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => {
      expect(useMcpRuntimeStore.getState().byId['srv1']?.status).toBe('failed');
    });
    expect(useMcpRuntimeStore.getState().byId['srv1']?.lastError).toBe('spawn ENOENT');
  });
});
