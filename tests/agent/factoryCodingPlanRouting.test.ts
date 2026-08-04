/**
 * factory 按协议分派 coding plan provider（Task 3）
 *
 * 验：
 * 1. glm-coding → 构造 AnthropicBackend，baseURL = 预设端点（大陆）
 * 2. 带 baseUrl override → override 生效
 * 3. authMode='bearer' 的三家 → 凭证走 authToken，不走 apiKey
 * 4. 既有 anthropic 直连 → apiKey 路径不变（回归），authToken 不传
 * 5. 既有 openrouter → 仍构造 OpenAICompatibleBackend（回归，anthropic-native 分派不误伤 openai-fc）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BackendProvider, RegisteredModel, Settings } from '@shared/types';

vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

// AnthropicBackend / OpenAICompatibleBackend 构造透传 spy——保留真实实现，只截获构造参数
// 普通函数表达式（非箭头）才能被 `new` 调用；返回真实实例透传
vi.mock('../../electron/main/agent/backends/anthropic', async (orig) => {
  const actual = await orig<typeof import('../../electron/main/agent/backends/anthropic')>();
  return {
    ...actual,
    AnthropicBackend: vi.fn(function (opts) {
      return new actual.AnthropicBackend(opts);
    }),
  };
});
vi.mock('../../electron/main/agent/backends/openaiCompatible', async (orig) => {
  const actual =
    await orig<typeof import('../../electron/main/agent/backends/openaiCompatible')>();
  return {
    ...actual,
    OpenAICompatibleBackend: vi.fn(function (opts) {
      return new actual.OpenAICompatibleBackend(opts);
    }),
  };
});

import { getSettings } from '../../electron/main/projects/store';
import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';
import { getBackendFor, __clearToolRegistryForTest } from '../../electron/main/agent/backends/factory';
import { makeSettings } from '../helpers/settings';

const EMPTY_ASSIGNMENTS = {
  twinMain: null,
  twinBackground: null,
  memoryDream: null,
  subagentCoder: null,
  conversationSummary: null,
  conversationTitle: null,
  twinSubagent: null,
  asideComment: null,
  loopReviewer: null,
};

function settingsWith(provider: BackendProvider, modelId: string): Settings {
  const model: RegisteredModel = {
    id: 'm1',
    providerId: provider.id,
    modelId,
    label: 'test model',
  } satisfies RegisteredModel;
  return makeSettings({
    providers: [provider],
    models: [model],
    modelAssignments: { ...EMPTY_ASSIGNMENTS, conversationTitle: model.id },
  });
}

beforeEach(() => {
  __clearToolRegistryForTest();
});
afterEach(() => {
  __clearToolRegistryForTest();
  vi.clearAllMocks();
});

describe('factory coding plan 协议分派', () => {
  it('glm-coding → AnthropicBackend，baseURL 为预设大陆端点，凭证走 authToken', async () => {
    const provider: BackendProvider = {
      id: 'p-glm',
      type: 'glm-coding',
      label: 'GLM Coding',
      apiKey: 'sk-glm-key',
    };
    vi.mocked(getSettings).mockResolvedValue(settingsWith(provider, 'glm-4.7'));

    await getBackendFor('conversationTitle');

    expect(AnthropicBackend).toHaveBeenCalledTimes(1);
    expect(OpenAICompatibleBackend).not.toHaveBeenCalled();
    const opts = vi.mocked(AnthropicBackend).mock.calls[0][0];
    expect(opts.baseURL).toBe('https://open.bigmodel.cn/api/anthropic');
    expect(opts.authToken).toBe('sk-glm-key'); // bearer → authToken
    expect(opts.apiKey).toBeFalsy(); // 不走 x-api-key
  });

  it('coding plan 带 baseUrl override → override 生效（海外端点）', async () => {
    const provider: BackendProvider = {
      id: 'p-mm',
      type: 'minimax-coding',
      label: 'MiniMax Coding',
      apiKey: 'sk-mm',
      baseUrl: 'https://api.minimax.io/anthropic',
    };
    vi.mocked(getSettings).mockResolvedValue(settingsWith(provider, 'MiniMax-M2.5'));

    await getBackendFor('conversationTitle');

    const opts = vi.mocked(AnthropicBackend).mock.calls[0][0];
    expect(opts.baseURL).toBe('https://api.minimax.io/anthropic');
  });

  it('回归：anthropic 直连仍走 apiKey，不传 authToken', async () => {
    const provider: BackendProvider = {
      id: 'p-anth',
      type: 'anthropic',
      label: 'Anthropic',
      apiKey: 'sk-anth',
    };
    vi.mocked(getSettings).mockResolvedValue(settingsWith(provider, 'claude-sonnet-4-6'));

    await getBackendFor('conversationTitle');

    const opts = vi.mocked(AnthropicBackend).mock.calls[0][0];
    expect(opts.apiKey).toBe('sk-anth');
    expect(opts.authToken).toBeFalsy();
    expect(opts.baseURL).toBeUndefined(); // 官方端点
  });

  it('回归：openrouter 仍构造 OpenAICompatibleBackend（不被 anthropic-native 误吞）', async () => {
    const provider: BackendProvider = {
      id: 'p-or',
      type: 'openrouter',
      label: 'OpenRouter',
      apiKey: 'sk-or',
    };
    vi.mocked(getSettings).mockResolvedValue(settingsWith(provider, 'openai/gpt-5-mini'));

    await getBackendFor('conversationTitle');

    expect(OpenAICompatibleBackend).toHaveBeenCalledTimes(1);
    expect(AnthropicBackend).not.toHaveBeenCalled();
  });
});
