/**
 * 调试日志留存：只保留最近 7 天（今天 + 前 6 天），更早的天目录整目录删除。
 *
 * 触发时机两处：
 * - 启动时（index.ts）——覆盖"应用没常开 / 调试日志已关闭但旧日志还在盘上"；
 * - beginRound 换日时（logger.ts）——覆盖"应用连续开一周以上"，不引入定时器。
 *
 * 删除吞错——与 debug 模块 die quietly 的既有约定一致（writer.ts 同）。
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const DEBUG_RETENTION_DAYS = 7;

/** 天目录命名形态（writer 按 dateKey 建目录）；不匹配的条目一律不碰 */
const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ts → 本地日期 YYYY-MM-DD（writer 落盘分目录用的同一口径） */
export function dateKey(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** 纯函数：目录条目里挑出过期的天目录名。用日历日算边界（setDate 而非减固定毫秒，跨 DST 不漂） */
export function selectExpiredDebugDayDirs(entries: string[], now: number): string[] {
  const d = new Date(now);
  d.setDate(d.getDate() - (DEBUG_RETENTION_DAYS - 1));
  const cutoff = dateKey(d.getTime());
  return entries.filter((name) => DAY_DIR_RE.test(name) && name < cutoff);
}

/** 删 root 下过期天目录。root 不存在 / 单目录删失败都静默 */
export async function sweepExpiredDebugDays(root: string, now = Date.now()): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  for (const name of selectExpiredDebugDayDirs(entries, now)) {
    try {
      await fs.rm(join(root, name), { recursive: true, force: true });
    } catch (e) {
      console.warn('[debug.retention] rm failed', name, e);
    }
  }
}
