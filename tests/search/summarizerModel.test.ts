/**
 * 网页超长提取走小模型（S34 · G26，锚 conversation-flow.html#Ingest）。
 *
 * 目标态：超长网页二次提取用一个小模型，而不是主对话同款模型。落法＝路由到 conversationSummary
 * 用途（廉价摘要器）。本测试钉住这条路由：summarizeIfNeeded 触发提取时，getBackendFor 必须以
 * 'conversationSummary' 取后端，绝不再按调用方 usage（= 主对话模型）取。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ORU_DIR = join(tmpdir(), `oru-test-summ-${Date.now()}`);

const { getSettingsMock, getBackendForMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
  getBackendForMock: vi.fn<(typeof import('../../electron/main/agent/backends/factory'))['getBackendFor']>(),
}));
vi.mock('../../electron/main/projects/store', async (orig) => ({ ...(await orig()), getSettings: getSettingsMock }));
vi.mock('../../electron/main/agent/backends/factory', async (orig) => ({ ...(await orig()), getBackendFor: getBackendForMock }));

import { summarizeIfNeeded } from '../../electron/main/search/summarizer';

const ctx = {
  abortSignal: new AbortController().signal,
  conversationId: 'c',
  agentId: 'a',
  ownerId: 'o',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  getSettingsMock.mockResolvedValue({ webSearch: { longPageSummary: true } } as never);
  getBackendForMock.mockResolvedValue({
    modelId: 'm',
    modelRegistryId: undefined,
    providerId: undefined,
    runOneShot: async () => ({ text: '提炼后的正文' }),
  } as never);
});

describe('summarizeIfNeeded 走小模型（G26）', () => {
  it('超长文本触发提取 → 以 conversationSummary 取后端（非主对话 usage）', async () => {
    const long = '网'.repeat(6000); // > SUMMARY_THRESHOLD(5000)
    const out = await summarizeIfNeeded(long, ctx);

    expect(out.summarized).toBe(true);
    expect(out.text).toBe('提炼后的正文');
    expect(getBackendForMock).toHaveBeenCalledTimes(1);
    expect(getBackendForMock).toHaveBeenCalledWith('conversationSummary');
  });

  it('短文本不触发 → 不取后端、原样返回', async () => {
    const out = await summarizeIfNeeded('短', ctx);
    expect(out.summarized).toBe(false);
    expect(getBackendForMock).not.toHaveBeenCalled();
  });
});
