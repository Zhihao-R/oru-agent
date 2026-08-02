import { describe, it, expect } from 'vitest';
import { getRecommendations } from '../../electron/main/agent/backends/recommendations';

// 三家 coding plan 的一键推荐模型（Task 4）。
describe('coding plan 推荐模型', () => {
  it('三家各有非空推荐', () => {
    expect(getRecommendations('glm-coding').length).toBeGreaterThan(0);
    expect(getRecommendations('kimi-coding').length).toBeGreaterThan(0);
    expect(getRecommendations('minimax-coding').length).toBeGreaterThan(0);
  });

  it('coding plan 推荐一律 supportsPromptCache=false（第三方端点容忍≠生效，默认关最安全）', () => {
    for (const t of ['glm-coding', 'kimi-coding', 'minimax-coding'] as const) {
      for (const rec of getRecommendations(t)) {
        expect(rec.supportsPromptCache, `${t} 的 ${rec.modelId}`).toBe(false);
      }
    }
  });

  it('既有类型推荐不变（回归）', () => {
    expect(getRecommendations('anthropic').length).toBeGreaterThan(0);
    expect(getRecommendations('custom-openai')).toEqual([]);
  });
});
