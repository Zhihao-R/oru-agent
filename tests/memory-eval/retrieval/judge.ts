/**
 * 召回指标计算（决策 1 / Task 1）
 *
 * 为什么是纯函数、不用 LLM judge：本评估的金标准是 episode 的**精确路径**
 * （compressedPath），召回判定就是"模型捞回的路径集合 ∩ golden"——一个确定的集合运算。
 * 用 LLM 给"召回准不准"打分反而引入一个会自己出错的环节，不如直接算交集可靠。
 * （现有 tests/memory-eval/judge.ts 测的是"写入分类"，金标准模糊、才需要 LLM judge；
 *  那里借的是 openaiClient 的调用方式，本文件只复用它的"自建 judge"定位，指标全不同。）
 *
 * 三档指标分开定位失效点：
 *   - injectionRecall：golden 出现在注入索引里的比例 —— 截断前的天花板
 *   - toolRecall：模型用 grep/query 实际捞回的比例 —— 子串/结构化兜底的真实能力
 *   - grepMissRate：golden 既不在注入、grep 也没捞回 / 不在注入 —— 是否需要语义检索的判据
 */
import type { RetrievalResult } from './retrieval';

export type RetrievalMetrics = {
  injectionRecall: number;
  toolRecall: number;
  grepMissRate: number;
  // 绝对计数（报告 + 自检用）
  totalGolden: number;
  injectedHits: number;
  toolHits: number;
  notInInjection: number; // golden 不在注入索引的总数（grepMissRate 的分母）
  grepMisses: number; // 不在注入且 grep 也没捞回（grepMissRate 的分子）
};

/** 把若干 RetrievalResult 汇总成三档指标。纯函数，逐 golden 计数后聚合。 */
export function computeMetrics(results: RetrievalResult[]): RetrievalMetrics {
  let totalGolden = 0;
  let injectedHits = 0;
  let toolHits = 0;
  let notInInjection = 0;
  let grepMisses = 0;

  for (const r of results) {
    const injected = new Set(r.injectedVisible);
    const tool = new Set(r.toolRecalled);
    for (const g of r.golden) {
      totalGolden += 1;
      const inInjection = injected.has(g);
      const inTool = tool.has(g);
      if (inInjection) injectedHits += 1;
      if (inTool) toolHits += 1;
      if (!inInjection) {
        notInInjection += 1;
        if (!inTool) grepMisses += 1;
      }
    }
  }

  return {
    injectionRecall: ratio(injectedHits, totalGolden),
    toolRecall: ratio(toolHits, totalGolden),
    grepMissRate: ratio(grepMisses, notInInjection),
    totalGolden,
    injectedHits,
    toolHits,
    notInInjection,
    grepMisses,
  };
}

/** 失败 case：golden 既没注入、grep 也没捞回——报告里逐条列出，是改进的直接线索 */
export type MissCase = { q: string; mode: string; missed: string[] };

export function collectMisses(results: RetrievalResult[]): MissCase[] {
  const out: MissCase[] = [];
  for (const r of results) {
    const injected = new Set(r.injectedVisible);
    const tool = new Set(r.toolRecalled);
    const missed = r.golden.filter((g) => !injected.has(g) && !tool.has(g));
    if (missed.length > 0) out.push({ q: r.q, mode: r.mode, missed });
  }
  return out;
}

function ratio(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}
