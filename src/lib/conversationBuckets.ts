/**
 * 对话列表时间分段（对话栏整理 2026-06-19）。
 * 列表是「时间日志」：今天 / 本周摊开，更早折进收纳区。就三段，不上更细分级。
 */

import type { TFunction } from 'i18next';

export type ConversationBucket = 'today' | 'week' | 'earlier';

/**
 * 列表分组（含时间段 + 已归档）的展示标签。
 * 与 typeLabel/kindLabel 那类「裸键」不同：本标签**跨 ns 复用**（ConversationList 绑 conversation、
 * scheduledTask 选择器绑 scheduledTask 都用它），故把 `conversation:` 前缀内置在此——消费者无论
 * 绑哪个 ns 都能解析；改成裸键会让 scheduledTask 侧静默回落（fallbackLng=zh 下不显错、英文期才炸）。
 */
export function bucketLabel(bucket: ConversationBucket | 'archived', t: TFunction): string {
  return t(`conversation:bucket.${bucket}`);
}

/**
 * 把对话的 updatedAt 归到时间分段。
 * - today：与 now 同一自然日（本地零点为界）
 * - week：本自然周内、但不在今天（周一为周首，简体中文习惯）
 * - earlier：本周周首之前
 *
 * now 显式传入（默认 Date.now()）便于测试，不在内部硬读时钟。
 * 用 Date 构造换算周首（而非减毫秒），天然跨月/年边界正确；中国无夏令时，无 DST 偏移顾虑。
 */
export function bucketOf(updatedAt: number, now: number = Date.now()): ConversationBucket {
  const n = new Date(now);
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (updatedAt >= startOfToday) return 'today';
  // getDay(): 0=周日 … 6=周六；到本周一的天数
  const daysSinceMonday = (n.getDay() + 6) % 7;
  const startOfWeek = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysSinceMonday).getTime();
  if (updatedAt >= startOfWeek) return 'week';
  return 'earlier';
}
