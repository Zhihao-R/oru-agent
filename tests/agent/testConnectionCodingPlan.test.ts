/**
 * testConnection 对三家 coding plan 的探活（Task 4）
 *
 * 验：coding plan 类型走 Anthropic SDK 路径（非 openai-fc fetch），带预设 baseURL 与 authMode。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BackendProvider } from '@shared/types';

const { create, AnthropicCtor } = vi.hoisted(() => {
  const create = vi.fn().mockResolvedValue({ id: 'msg' });
  const AnthropicCtor = vi.fn(function () {
    return { messages: { create } };
  });
  return { create, AnthropicCtor };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicCtor }));

import { testProvider } from '../../electron/main/agent/backends/testConnection';

beforeEach(() => {
  create.mockClear();
  AnthropicCtor.mockClear();
});

describe('testConnection coding plan', () => {
  it('glm-coding → 走 Anthropic SDK，baseURL 为预设端点、凭证走 authToken', async () => {
    const provider: BackendProvider = {
      id: 'p',
      type: 'glm-coding',
      label: 'GLM Coding',
      apiKey: 'sk-glm',
    };

    const r = await testProvider(provider);

    expect(AnthropicCtor).toHaveBeenCalledTimes(1);
    const opts = AnthropicCtor.mock.calls[0][0];
    expect(opts.baseURL).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(opts.authToken).toBe('sk-glm');
    expect(opts.apiKey).toBeFalsy();
    expect(create).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });

  it('minimax-coding 带 override baseUrl → override 生效', async () => {
    const provider: BackendProvider = {
      id: 'p',
      type: 'minimax-coding',
      label: 'MiniMax Coding',
      apiKey: 'sk-mm',
      baseUrl: 'https://api.minimax.io/anthropic',
    };

    await testProvider(provider);

    const opts = AnthropicCtor.mock.calls[0][0];
    expect(opts.baseURL).toBe('https://api.minimax.io/anthropic');
  });

  it('回归：anthropic 直连仍走 apiKey（x-api-key），无 authToken', async () => {
    const provider: BackendProvider = {
      id: 'p',
      type: 'anthropic',
      label: 'Anthropic',
      apiKey: 'sk-anth',
    };

    await testProvider(provider);

    const opts = AnthropicCtor.mock.calls[0][0];
    expect(opts.apiKey).toBe('sk-anth');
    expect(opts.authToken).toBeFalsy();
  });
});
