/**
 * 预算两级线的纯判定（理想架构 S15 · G111）——无 I/O，主进程与渲染层共用一份。
 */
import type { BudgetSettings } from '../types';
import type { BudgetLevel, BudgetStatus } from './types';

/** 软警戒比例缺省 0.8，越界（NaN / <0 / >1）夹回 [0,1]。 */
function clampRatio(r: number | undefined): number {
  if (typeof r !== 'number' || !Number.isFinite(r)) return 0.8;
  return Math.min(1, Math.max(0, r));
}

/**
 * 给定窗口内已用 token 与预算配置，算当前处于哪一级线。
 * 关闭 / 硬上限非正 → 'off'：预算是用户对钱包的决定权，未设即不设限。
 */
export function evaluateBudget(spentTokens: number, budget: BudgetSettings | undefined): BudgetStatus {
  const hardLimitTokens = budget?.enabled && budget.hardLimitTokens > 0 ? budget.hardLimitTokens : 0;
  if (hardLimitTokens <= 0) {
    return { level: 'off', spentTokens, softLimitTokens: 0, hardLimitTokens: 0 };
  }
  const softLimitTokens = Math.round(hardLimitTokens * clampRatio(budget!.softRatio));
  const level: BudgetLevel =
    spentTokens >= hardLimitTokens ? 'hard' : spentTokens >= softLimitTokens ? 'soft' : 'ok';
  return { level, spentTokens, softLimitTokens, hardLimitTokens };
}
