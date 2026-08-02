/**
 * 档案记忆「撤回这次修改」的定位。
 *
 * 档案是一份连续文档，AI 改的是其中一段——没有「这条记忆」这个可以整体挪走的实体。所以撤回
 * 只能是「回到这次写入之前那一版」，靠卡片里带的 revertHash（那次写入后的完整文件 hash）
 * 在 FileHistory 里认出「这次修改」，再取它前面一版。
 *
 * 拒绝比错撤重要：这之后档案若又被改过（AI 再记、用户自己在浮层里编辑），回滚会把后来的改动
 * 一并抹掉。此时宁可拒绝并说清楚，让用户去档案历史里自己挑。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as fileHistory from '../fs/fileHistory';
import { readWithMetaAsync } from '../fs/safeWrite';

export type RevertTarget =
  | { ok: true; snapshotId: string }
  /**
   * changed-since：之后又被改过（或文件已不在）——回滚会连带撤掉后来的修改
   * history-gone：那一版已不在历史里（兜底版本过期即删，见 fileHistory 的 GC 三路）
   * ambiguous：历史里有多版同内容，认不出「哪一次」——见下面取版处注释
   * no-earlier-version：历史里没有更早的版本可回
   */
  | { ok: false; reason: 'changed-since' | 'history-gone' | 'ambiguous' | 'no-earlier-version' };

export async function resolveRevertTarget(
  absPath: string,
  afterHash: string,
): Promise<RevertTarget> {
  const key = resolve(absPath); // 与 commitWorkfileWrite / FileHistory 同一 fileKey 口径
  if (!existsSync(key)) return { ok: false, reason: 'changed-since' };
  // readWithMetaAsync 的 BOM/CRLF 归一与写入侧同口径——否则同一逻辑内容算出两个 hash，永远比不上
  const cur = (await readWithMetaAsync(key)).content;
  if (fileHistory.contentHash(cur) !== afterHash) return { ok: false, reason: 'changed-since' };

  const snaps = await fileHistory.list(key);
  const hits: number[] = [];
  for (let i = 0; i < snaps.length; i++) {
    if (snaps[i].hash === afterHash) hits.push(i);
  }
  if (hits.length === 0) return { ok: false, reason: 'history-gone' };
  // 内容绕回过同一字面（A→B→C→B）：hash 认不出「哪一次」，取最近那条会把档案恢复成 C——
  // 一个用户从没见过的中间态。认不准就不撤，让用户去历史里自己挑。
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' };
  const idx = hits[0];
  if (idx === 0) return { ok: false, reason: 'no-earlier-version' };
  return { ok: true, snapshotId: snaps[idx - 1].id };
}
