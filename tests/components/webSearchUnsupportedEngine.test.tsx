/** @vitest-environment jsdom */
/**
 * 设置 ▸ Web 搜索 ▸ 未知引擎灰化行（AnySearch 接入·批 1）：
 * - unsupportedEngines 条目渲染为灰化行：原始 type + 「来自其他版本，不再支持」+ 删除按钮
 * - 点删除 → settings.update 带完整 webSearch 且 unsupportedEngines 不再含该条目
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { WebSearchSettings } from '@shared/types';

const ws = vi.hoisted(() => ({
  impl: (async (_p: ClientRequestPayload): Promise<ServerEventPayload> => {
    throw new Error('ws.impl 未配置');
  }) as (p: ClientRequestPayload) => Promise<ServerEventPayload>,
  calls: [] as ClientRequestPayload[],
}));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> => {
      ws.calls.push(payload);
      return (await ws.impl(payload)) as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { WebSearchSettingsSection } from '@/components/WebSearchSettingsSection';
import { useSettingsStore } from '@/stores/settingsStore';

function setWebSearch(webSearch: WebSearchSettings): void {
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, webSearch } }));
}

beforeEach(() => {
  ws.calls.length = 0;
  ws.impl = async (p) => {
    if (p.type === 'settings.update') {
      return { type: 'settings.state', settings: useSettingsStore.getState().settings };
    }
    throw new Error(`未配置的请求：${p.type}`);
  };
});
afterEach(cleanup);

describe('未知引擎灰化行', () => {
  it('渲染原始 type + 不再支持提示 + 删除按钮', () => {
    setWebSearch({
      enabled: true,
      engines: [],
      longPageSummary: true,
      unsupportedEngines: [{ id: 'eng_ghost', type: 'ghost', apiKey: 'gk' }],
    });
    render(<WebSearchSettingsSection />);

    expect(screen.getByText('ghost')).toBeTruthy();
    expect(screen.getByText('来自其他版本，不再支持')).toBeTruthy();
    expect(screen.getByTitle('删除此引擎')).toBeTruthy();
  });

  it('点删除 → settings.update 的 unsupportedEngines 不再含该条目', () => {
    setWebSearch({
      enabled: true,
      engines: [],
      longPageSummary: true,
      unsupportedEngines: [{ id: 'eng_ghost', type: 'ghost', apiKey: 'gk' }],
    });
    render(<WebSearchSettingsSection />);
    fireEvent.click(screen.getByTitle('删除此引擎'));

    expect(
      ws.calls.some(
        (c) =>
          c.type === 'settings.update' &&
          c.settings.webSearch?.unsupportedEngines?.length === 0 &&
          c.settings.webSearch?.enabled === true,
      ),
    ).toBe(true);
  });

  it('没有 unsupportedEngines 时不渲染灰化行', () => {
    setWebSearch({ enabled: true, engines: [], longPageSummary: true });
    render(<WebSearchSettingsSection />);
    expect(screen.queryByText('来自其他版本，不再支持')).toBeNull();
  });
});
