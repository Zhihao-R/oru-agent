/**
 * 预算两级线纯判定单测（S15 · G111）——关/正常/软/硬四级与边界、比例夹取。
 */
import { describe, expect, it } from 'vitest';
import type { BudgetSettings } from '../../shared/types';
import { evaluateBudget } from '../../shared/budget/evaluate';

const on = (over: Partial<BudgetSettings> = {}): BudgetSettings => ({
  enabled: true,
  hardLimitTokens: 1000,
  softRatio: 0.8,
  ...over,
});

describe('evaluateBudget', () => {
  it('未配置 / 关闭 / 硬上限非正 → off', () => {
    expect(evaluateBudget(999999, undefined).level).toBe('off');
    expect(evaluateBudget(999999, on({ enabled: false })).level).toBe('off');
    expect(evaluateBudget(999999, on({ hardLimitTokens: 0 })).level).toBe('off');
  });

  it('分三级：ok < 软线 ≤ soft < 硬线 ≤ hard', () => {
    expect(evaluateBudget(0, on()).level).toBe('ok');
    expect(evaluateBudget(799, on()).level).toBe('ok');
    expect(evaluateBudget(800, on()).level).toBe('soft'); // 软线 = 1000*0.8，含端点
    expect(evaluateBudget(999, on()).level).toBe('soft');
    expect(evaluateBudget(1000, on()).level).toBe('hard'); // 硬上限含端点
    expect(evaluateBudget(5000, on()).level).toBe('hard');
  });

  it('回带算好的两条线', () => {
    const s = evaluateBudget(850, on());
    expect(s).toMatchObject({ level: 'soft', spentTokens: 850, softLimitTokens: 800, hardLimitTokens: 1000 });
  });

  it('softRatio 越界夹回 [0,1]，非法回落 0.8', () => {
    expect(evaluateBudget(0, on({ softRatio: -1 })).softLimitTokens).toBe(0); // 夹到 0 → 软线=0
    expect(evaluateBudget(0, on({ softRatio: 2 })).softLimitTokens).toBe(1000); // 夹到 1 → 软线=硬线
    expect(evaluateBudget(0, on({ softRatio: NaN })).softLimitTokens).toBe(800); // 非法回落 0.8
  });
});
