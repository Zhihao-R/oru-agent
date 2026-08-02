/**
 * 追加拼接的单一定义 —— append_file 工具算 diff 预览、执行器锁内落盘，共用这一份。
 *
 * 两处必须同一个函数：预览与落盘对不上就是「所见非所批」。
 */
import { canonicalizeCsvText } from '@shared/csv';

/**
 * .csv 走表格的字节形态定义：记录以换行分隔，所以原文没有尾换行时补一个——否则追加的第一行会
 * 跟原文最后一行黏成同一条记录（真损坏，不是风格问题）。拼完整篇定型（摘掉不必要的引号），
 * canonicalizeCsvText 自带安全阀，认不出的表原样退回、绝不改坏。
 *
 * 非 .csv 逐字面追加——替调用方补换行是猜，猜错就是改了它没让改的字节。
 */
export function joinAppend(path: string, base: string, tail: string): string {
  if (!path.toLowerCase().endsWith('.csv')) return base + tail;
  const joined = base.length > 0 && !base.endsWith('\n') ? `${base}\n${tail}` : base + tail;
  return canonicalizeCsvText(joined);
}
