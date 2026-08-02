import { describe, it, expect } from 'vitest';
import type { BackendProviderType } from '@shared/types';
import { resolveAnthropicCompatiblePreset } from '../../electron/main/agent/backends/providerPresets';

// anthropic-native 协议各类型的端点 + 鉴权模式预设解析（对位 resolveOpenAICompatibleBaseURL）。
describe('resolveAnthropicCompatiblePreset', () => {
  it('三家 coding plan 无 override 时返回预设默认端点', () => {
    expect(resolveAnthropicCompatiblePreset('glm-coding').baseUrl).toContain('anthropic');
    expect(resolveAnthropicCompatiblePreset('kimi-coding').baseUrl).toContain('anthropic');
    expect(resolveAnthropicCompatiblePreset('minimax-coding').baseUrl).toContain('anthropic');
  });

  it('override 优先于预设默认', () => {
    const r = resolveAnthropicCompatiblePreset('glm-coding', 'https://my.proxy/anthropic');
    expect(r.baseUrl).toBe('https://my.proxy/anthropic');
  });

  it('override 末尾斜杠被剥掉', () => {
    const r = resolveAnthropicCompatiblePreset('glm-coding', 'https://my.proxy/anthropic/');
    expect(r.baseUrl).toBe('https://my.proxy/anthropic');
  });

  it('anthropic 直连无预设 → baseUrl undefined(SDK 用官方端点) + authMode x-api-key', () => {
    const r = resolveAnthropicCompatiblePreset('anthropic');
    expect(r.baseUrl).toBeUndefined();
    expect(r.authMode).toBe('x-api-key');
  });

  it('anthropic 直连允许 override baseUrl(自建代理)', () => {
    const r = resolveAnthropicCompatiblePreset('anthropic', 'https://proxy.local');
    expect(r.baseUrl).toBe('https://proxy.local');
    expect(r.authMode).toBe('x-api-key');
  });

  it('三家 coding plan 的 authMode 明确(非 undefined)', () => {
    for (const t of ['glm-coding', 'kimi-coding', 'minimax-coding'] as const) {
      expect(['x-api-key', 'bearer']).toContain(resolveAnthropicCompatiblePreset(t).authMode);
    }
  });

  it('fail-closed：未登记的 anthropic-native 类型缺 baseUrl 抛错', () => {
    // 模拟"将来新增的 anthropic-native 类型但漏填预设"——绝不静默用空端点
    expect(() => resolveAnthropicCompatiblePreset('future-coding' as BackendProviderType)).toThrow();
  });
});
