/** @vitest-environment jsdom */
/**
 * 设置 ▸ 界面 ▸ 自动归档（对话归档）：
 * - 默认开（settings.autoArchive.enabled）；开时显示「归档时长」输入、关时隐藏。
 * - 拨开关 / 改时长 → settings.update 带完整 autoArchive 对象（shallow merge 安全）。
 * - autoArchive 缺省（首屏未拉到后端权威值）→ 回落开 + 168。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { AutoArchiveSettings } from '@shared/types';

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

import { ArchiveSection } from '@/components/settings/DataSection';
import { useSettingsStore } from '@/stores/settingsStore';

function setAutoArchive(autoArchive?: AutoArchiveSettings): void {
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, autoArchive } }));
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

describe('自动归档设置', () => {
  it('默认开：开关 on + 显示归档时长输入（值 168）', () => {
    setAutoArchive({ enabled: true, thresholdHours: 168 });
    render(<ArchiveSection />);
    expect(screen.getByRole('switch', { name: '自动归档对话' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect((screen.getByLabelText('归档时长（小时）') as HTMLInputElement).value).toBe('168');
  });

  it('关：开关 off + 时长输入隐藏', () => {
    setAutoArchive({ enabled: false, thresholdHours: 168 });
    render(<ArchiveSection />);
    expect(
      screen.getByRole('switch', { name: '自动归档对话' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.queryByLabelText('归档时长（小时）')).toBeNull();
  });

  it('拨关开关 → settings.update { autoArchive:{enabled:false, thresholdHours:168} }', () => {
    setAutoArchive({ enabled: true, thresholdHours: 168 });
    render(<ArchiveSection />);
    fireEvent.click(screen.getByRole('switch', { name: '自动归档对话' }));
    expect(
      ws.calls.some(
        (c) =>
          c.type === 'settings.update' &&
          c.settings.autoArchive?.enabled === false &&
          c.settings.autoArchive?.thresholdHours === 168,
      ),
    ).toBe(true);
  });

  it('改时长 → settings.update thresholdHours', () => {
    setAutoArchive({ enabled: true, thresholdHours: 168 });
    render(<ArchiveSection />);
    fireEvent.change(screen.getByLabelText('归档时长（小时）'), { target: { value: '24' } });
    expect(
      ws.calls.some(
        (c) => c.type === 'settings.update' && c.settings.autoArchive?.thresholdHours === 24,
      ),
    ).toBe(true);
  });

  it('autoArchive 缺省（首屏未拉到后端权威值）→ 回落开 + 168', () => {
    setAutoArchive(undefined);
    render(<ArchiveSection />);
    expect(
      screen.getByRole('switch', { name: '自动归档对话' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect((screen.getByLabelText('归档时长（小时）') as HTMLInputElement).value).toBe('168');
  });
});
