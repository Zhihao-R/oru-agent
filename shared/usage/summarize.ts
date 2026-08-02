/**
 * 用量账本的纯聚合（理想架构 S13 · G110）——无 I/O，主进程（预算闸门 S15）与渲染层（时间范围
 * 切换即时重算）共用一份，避免两端口径漂移。
 */
import type { LlmUsage } from '../types';
import type { UsageBucket, UsageLedgerFile, UsageSummary, UsagePurposeTotal } from './types';

/** 本地时区 YYYY-MM-DD——账本按用户的「一天」算，字符串序即时间序（范围过滤靠它）。 */
export function localDayKey(at: number): string {
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 把日桶在 [from, to] 范围内按用途求和。范围端点转成 dayKey 后按字符串序过滤；端点为 null =
 * 该侧不限。byPurpose 按 token 总量降序、零用途不列。
 */
export function summarizeUsage(
  days: UsageLedgerFile['days'],
  range: { from?: number | null; to?: number | null } = {},
): UsageSummary {
  const from = range.from ?? null;
  const to = range.to ?? null;
  const fromKey = from != null ? localDayKey(from) : null;
  const toKey = to != null ? localDayKey(to) : null;

  const perPurpose = new Map<LlmUsage, UsagePurposeTotal>();
  const total = { inputTokens: 0, outputTokens: 0, calls: 0 };

  for (const [dayKey, purposes] of Object.entries(days)) {
    if (fromKey != null && dayKey < fromKey) continue;
    if (toKey != null && dayKey > toKey) continue;
    for (const [purpose, bucket] of Object.entries(purposes) as [LlmUsage, UsageBucket][]) {
      const row = perPurpose.get(purpose) ?? { purpose, inputTokens: 0, outputTokens: 0, calls: 0 };
      row.inputTokens += bucket.inputTokens;
      row.outputTokens += bucket.outputTokens;
      row.calls += bucket.calls;
      perPurpose.set(purpose, row);
      total.inputTokens += bucket.inputTokens;
      total.outputTokens += bucket.outputTokens;
      total.calls += bucket.calls;
    }
  }

  const byPurpose = Array.from(perPurpose.values())
    .filter((r) => r.inputTokens + r.outputTokens > 0)
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return { from, to, total, byPurpose };
}
