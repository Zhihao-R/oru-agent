/**
 * 预算两级线的判定结果（理想架构 S15 · G111）。主进程（无人值守闸 + 信号）与渲染层
 * （设置页状态显示）共用，避免口径漂移。
 */
import type { BudgetSettings } from '../types';

/** 默认配置：默认关（预算是用户对钱包的决定权，系统不预设数字）。单一信源，store 与设置 UI 共用。 */
export const DEFAULT_BUDGET: BudgetSettings = { enabled: false, hardLimitTokens: 10_000_000, softRatio: 0.8 };

/** 当前处于哪一级：关 / 正常 / 到软警戒 / 到硬上限。 */
export type BudgetLevel = 'off' | 'ok' | 'soft' | 'hard';

export type BudgetStatus = {
  level: BudgetLevel;
  /** 窗口内已用 token（input + output）。 */
  spentTokens: number;
  /** 软警戒线（token）；off 时为 0。 */
  softLimitTokens: number;
  /** 硬上限（token）；off 时为 0。 */
  hardLimitTokens: number;
};
