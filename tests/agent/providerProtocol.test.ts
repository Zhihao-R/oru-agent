import { describe, it, expect } from 'vitest';
import { providerProtocol } from '@shared/agent/providerProtocol';

// providerProtocol: provider 类型 → 线上协议。factory / testConnection 据此二分分派。
describe('providerProtocol', () => {
  it('anthropic 直连走 anthropic-native', () => {
    expect(providerProtocol('anthropic')).toBe('anthropic-native');
  });

  it('三家 coding plan(GLM/Kimi/MiniMax)走 anthropic-native', () => {
    expect(providerProtocol('glm-coding')).toBe('anthropic-native');
    expect(providerProtocol('kimi-coding')).toBe('anthropic-native');
    expect(providerProtocol('minimax-coding')).toBe('anthropic-native');
  });

  it('OpenAI 兼容各家走 openai-fc', () => {
    expect(providerProtocol('openrouter')).toBe('openai-fc');
    expect(providerProtocol('openai')).toBe('openai-fc');
    expect(providerProtocol('zhipu')).toBe('openai-fc');
    expect(providerProtocol('kimi')).toBe('openai-fc');
    expect(providerProtocol('custom-openai')).toBe('openai-fc');
  });
});
