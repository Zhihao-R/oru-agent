/**
 * 结构粗筛 —— recall 流水线候选收集的第三档（PRD §5.3 / §5.4，gate 在数据后）
 *
 * 「随规模变化的，只有怎么收集候选」。这一步是同一条管子加挂的「砍候选」，不改下游（判断/注入/围栏一字不变）。
 * 只按**硬维度**砍（类别·项目·新旧），不按话题、不预建聚类——真正的「话题相关」判断全交给挑选器读简介。
 *
 * 两维硬粗筛：**项目归属**（G20，先砍）＋**近期预算**（后砍）。
 * - 项目维（filterBriefsByProject）：候选＝当前项目条目＋不带项目标注的全局条目，排除明确属于其他项目
 *   的事件（context-memory.html#RC1 / channels.html#project，2026-07-10 PM 修订口径）。当前无项目
 *   （自由聊天 / 渠道回合）→ 只圈全局条目。「当前项目」由 recall 调用方传入（现取 getActiveProjectId）。
 * - 近期维（prefilterBriefsByBudget）：briefs 已按 updated 倒序，超预算时取最近的前缀。触发可判定
 *   （简介块字符 > 预算）；预算默认大到正常规模不触发。
 */
import type { EpisodeBrief } from './briefs';

/** 默认简介块字符预算——超过才粗筛（约对应数百条简介）。正常规模喂得下、不触发。 */
export const BRIEF_BUDGET_CHARS = 20_000;

/**
 * 项目维粗筛（G20）：只按「归属」这个硬维度砍，不看内容。
 * 保留＝不带项目标注的全局条目（projectId 为空）＋当前项目的条目；排除＝明确属于其他项目的。
 * currentProjectId 为空（无当前项目）时只留全局条目（其余都算「别的项目」）。
 */
export function filterBriefsByProject(
  briefs: EpisodeBrief[],
  currentProjectId: string | null | undefined,
): EpisodeBrief[] {
  return briefs.filter(
    (b) => b.projectId == null || b.projectId === currentProjectId,
  );
}

export function prefilterBriefsByBudget(briefs: EpisodeBrief[], maxChars: number): EpisodeBrief[] {
  if (briefs.length === 0) return briefs;
  let used = 0;
  const kept: EpisodeBrief[] = [];
  for (const b of briefs) {
    used += b.line.length;
    if (used > maxChars && kept.length >= 1) break; // 超预算就停，但至少留 1 条
    kept.push(b);
  }
  return kept;
}
