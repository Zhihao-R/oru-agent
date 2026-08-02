/**
 * 按用途归账的用量账本（理想架构 S13 · G110）——数据形状，主进程与渲染层共用。
 *
 * 「用途」直接复用模型接入层的分配单位 LlmUsage（主对话 / 记忆召回 / 夜间整理 / subagent /
 * Loop 审查员 …）——账本按用途归账，正是「分配表现成的把手」：看到某用途花得多，去模型分配处
 * 给它换个便宜模型。计量只落 token（既成事实、逐字节不会过期）；金额是易过期的派生，不落盘，
 * 也不由本层展示（2026-07-10 PM 拍板：token 就够，不做金额估算）。
 */
import type { LlmUsage } from '../types';

/** 单个 (本地日期, 用途) 桶的 token 累计——账本的最小落盘单元。 */
export type UsageBucket = {
  inputTokens: number;
  outputTokens: number;
  /** 该桶累计的模型调用次数（一轮多次工具调用只在 result 结算一次，故 ≈ 回合数） */
  calls: number;
};

/**
 * 落盘账本：版本封套 + 「本地日期 → 用途 → 桶」双层聚合。
 * 按日期分桶让任意时间范围（今天 / 本周 / 本月 / 全部）都能由日桶求和得出，无需存每次调用明细
 * （明细留在开发者调试日志，本账本只做用户可见的粗聚合）。
 */
export type UsageLedgerFile = {
  version: number;
  days: Record<string, Partial<Record<LlmUsage, UsageBucket>>>;
};

/** 某时间范围内单个用途的合计。 */
export type UsagePurposeTotal = {
  purpose: LlmUsage;
  inputTokens: number;
  outputTokens: number;
  calls: number;
};

/** 给 UI / 预算闸门（S15）的时间范围聚合：总计 + 按用途分行（token 总量降序，零用途不列）。 */
export type UsageSummary = {
  /** 范围起止时刻（null = 不限）；纯做回显，不参与判定 */
  from: number | null;
  to: number | null;
  total: { inputTokens: number; outputTokens: number; calls: number };
  byPurpose: UsagePurposeTotal[];
};
