// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Settings } from '@shared/types';
import { makeSettings } from '../helpers/settings';

const baseSettings = makeSettings();

const requestMock = vi.fn();

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
  },
}));

import { useSettingsStore } from '@/stores/settingsStore';

describe('settingsStore colorScheme', () => {
  beforeEach(() => {
    requestMock.mockReset();
    useSettingsStore.setState({ settings: baseSettings });
  });

  it('update({ colorScheme }) 推主进程并 sync 回来', async () => {
    requestMock.mockResolvedValueOnce({
      type: 'settings.state',
      settings: { ...baseSettings, colorScheme: 'klein' },
    });

    await useSettingsStore.getState().update({ colorScheme: 'klein' });

    expect(requestMock).toHaveBeenCalledWith({
      type: 'settings.update',
      settings: { colorScheme: 'klein' },
    });
    expect(useSettingsStore.getState().settings.colorScheme).toBe('klein');
  });

  it('syncSettings 直接覆盖状态（用于 settings.state 广播）', () => {
    useSettingsStore.getState().syncSettings({ ...baseSettings, colorScheme: 'iris' });
    expect(useSettingsStore.getState().settings.colorScheme).toBe('iris');
  });

  it('syncSettings 归一已下架主题 id（盘上存量 sage/graphite 回落默认，不产生空选中态）', () => {
    useSettingsStore
      .getState()
      .syncSettings({ ...baseSettings, colorScheme: 'sage' as Settings['colorScheme'] });
    expect(useSettingsStore.getState().settings.colorScheme).toBe('terracotta');
  });

  it('update 是乐观更新——WS 失败也保留乐观值（最终一致靠后端 settings.state 广播）', async () => {
    requestMock.mockRejectedValueOnce(new Error('disconnected'));
    await useSettingsStore.getState().update({ colorScheme: 'mono' });
    // 乐观写入已生效；失败吞掉不回滚，后端最终会通过 settings.state 修正
    expect(useSettingsStore.getState().settings.colorScheme).toBe('mono');
  });
});
