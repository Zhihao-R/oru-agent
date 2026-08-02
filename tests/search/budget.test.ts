/**
 * 对话级搜索预算单测。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetBudgetMapForTest,
  consumeBudget,
  finalizeConversationBudget,
  getBudgetMapSizeForTest,
  getCurrentBudget,
  getMaxBudget,
  resetConversationBudget,
} from '../../electron/main/search/budget';

describe('budget', () => {
  beforeEach(() => {
    __resetBudgetMapForTest();
  });

  it('reset 后第一次 consume 返回 true', () => {
    resetConversationBudget('cnv1');
    expect(consumeBudget('cnv1')).toBe(true);
    expect(getCurrentBudget('cnv1')).toBe(1);
  });

  it('达到 MAX 后 consume 返回 false 且不再 +1', () => {
    resetConversationBudget('cnv1');
    const max = getMaxBudget();
    for (let i = 0; i < max; i += 1) {
      expect(consumeBudget('cnv1')).toBe(true);
    }
    expect(consumeBudget('cnv1')).toBe(false);
    expect(getCurrentBudget('cnv1')).toBe(max);
    expect(consumeBudget('cnv1')).toBe(false);
    expect(getCurrentBudget('cnv1')).toBe(max);
  });

  it('不同 conversationId 互不影响', () => {
    resetConversationBudget('a');
    resetConversationBudget('b');
    consumeBudget('a');
    consumeBudget('a');
    consumeBudget('b');
    expect(getCurrentBudget('a')).toBe(2);
    expect(getCurrentBudget('b')).toBe(1);
  });

  it('reset 同一 cnv 后 budget 归零', () => {
    consumeBudget('cnv1');
    consumeBudget('cnv1');
    expect(getCurrentBudget('cnv1')).toBe(2);
    resetConversationBudget('cnv1');
    expect(getCurrentBudget('cnv1')).toBe(0);
    expect(consumeBudget('cnv1')).toBe(true);
  });

  it('未曾 reset 过的 cnv 也能 consume（默认 0 起步）', () => {
    expect(consumeBudget('fresh')).toBe(true);
    expect(getCurrentBudget('fresh')).toBe(1);
  });

  it('finalize 真删 entry，避免一次性 conversationId 累积泄漏', () => {
    // 模拟一连串背景 query 跑完
    for (let i = 0; i < 100; i += 1) {
      const id = `bg_x_${i}`;
      consumeBudget(id);
      finalizeConversationBudget(id);
    }
    // 100 次背景 query 跑完后 Map 应是空的（不是 100）
    expect(getBudgetMapSizeForTest()).toBe(0);
  });
});
