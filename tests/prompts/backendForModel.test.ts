/**
 * getBackendForModel 单元测试
 *
 * 验证调试台用的「按任选模型构造 backend」入口：
 * - anthropic provider 的 model → AnthropicBackend
 * - openrouter provider 的 model → OpenAICompatibleBackend
 * - 构造出的 backend 带上 model.id（modelId）/ provider.id（providerId）
 *   —— 专门防止从 realGetBackendFor 抽取共享 helper 时漏传这俩字段
 *   （主对话流式 runner.ts / 中断恢复 interrupted.ts 依赖它们）
 * - 未知 modelId 抛 /未知模型/
 *
 * 不打真 API。getSettings 用 vi.mock 桩掉，喂入构造好的 fixture。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredModel, BackendProvider, Settings } from '@shared/types';
import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';
import { getBackendFor, getBackendForModel } from '../../electron/main/agent/backends/factory';
import { getSettings } from '../../electron/main/projects/store';
import { makeSettings } from '../helpers/settings';

// mock satisfies 真模块的导出签名（项目约定）——getSettings 签名变了这里编译期就红
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

const anthropicProvider: BackendProvider = {
  id: 'prov-anth',
  type: 'anthropic',
  label: 'Anthropic',
  apiKey: 'sk-anth-test',
};
const openrouterProvider: BackendProvider = {
  id: 'prov-or',
  type: 'openrouter',
  label: 'OpenRouter',
  apiKey: 'sk-or-test',
};
const anthropicModel: RegisteredModel = {
  id: 'model-anth',
  providerId: 'prov-anth',
  modelId: 'claude-sonnet-4-6',
  label: 'Sonnet 4.6',
  supportsVision: true,
  supportsPromptCache: true,
  maxOutputTokens: 8192,
};
const openrouterModel: RegisteredModel = {
  id: 'model-or',
  providerId: 'prov-or',
  modelId: 'openai/gpt-5',
  label: 'GPT-5',
  supportsVision: false,
  supportsReasoning: true,
  reasoningEffort: 'medium',
};

function fixtureSettings(): Settings {
  return makeSettings({
    providers: [anthropicProvider, openrouterProvider],
    models: [anthropicModel, openrouterModel],
    migratedFromManualApiKey: true,
  });
}

describe('getBackendForModel', () => {
  beforeEach(() => {
    vi.mocked(getSettings).mockResolvedValue(fixtureSettings());
  });

  it('anthropic provider 的 model → AnthropicBackend，带 modelId/providerId', async () => {
    const backend = await getBackendForModel('model-anth');
    expect(backend).toBeInstanceOf(AnthropicBackend);
    expect(backend.modelId).toBe('model-anth');
    expect(backend.providerId).toBe('prov-anth');
  });

  it('openrouter provider 的 model → OpenAICompatibleBackend，带 modelId/providerId', async () => {
    const backend = await getBackendForModel('model-or');
    expect(backend).toBeInstanceOf(OpenAICompatibleBackend);
    expect(backend.modelId).toBe('model-or');
    expect(backend.providerId).toBe('prov-or');
  });

  it('未知 modelId 抛 /未知模型/', async () => {
    await expect(getBackendForModel('does-not-exist')).rejects.toThrow(/未知模型/);
  });
});

describe('getBackendFor — asideComment 路由回落', () => {
  it('asideComment 未分配 → 回落 twinMain 所配模型（短评必须是"这个 Oru"说的）', async () => {
    const settings = fixtureSettings();
    settings.modelAssignments.twinMain = anthropicModel.id;
    vi.mocked(getSettings).mockResolvedValue(settings);

    const backend = await getBackendFor('asideComment');
    expect(backend).toBeInstanceOf(AnthropicBackend);
    expect(backend.modelId).toBe(anthropicModel.id);
    expect(backend.providerId).toBe(anthropicProvider.id);
  });

  it('asideComment 显式分配 → 尊重分配，不回落 twinMain', async () => {
    const settings = fixtureSettings();
    settings.modelAssignments.twinMain = anthropicModel.id;
    settings.modelAssignments.asideComment = openrouterModel.id;
    vi.mocked(getSettings).mockResolvedValue(settings);

    const backend = await getBackendFor('asideComment');
    expect(backend).toBeInstanceOf(OpenAICompatibleBackend);
    expect(backend.modelId).toBe(openrouterModel.id);
  });
});
