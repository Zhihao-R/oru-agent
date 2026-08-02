/**
 * bash 预期文件申报的核验内核（PRD 2026-07-27 第 7 项·三层方案「执行命令」层）。
 *
 * 模型写命令时随手申报「预期会改哪些文件」，命令跑完后在这里核验：逐路径比对执行前后的
 * 状态（存在性 + mtime/size），确实变动的才进「本轮文件变更」条。op 由比对推导、不由模型
 * 自报——核验本来就要读前后状态，操作类型是它的副产品，自报反而可能错。无变化 = 未通过
 * 核验，丢弃（说错的、编的不进条）；漏报（没申报就没记录）是三层方案接受的残余风险。
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FileChangeOp } from '@shared/agent/structuredMarkers';

type FileState = { exists: boolean; mtimeMs: number; size: number };
export type ExpectedFilesSnapshot = Map<string, FileState>;

/** 校验 + 按 cwd 解析相对路径 + 去重。格式坏了不拦命令——申报只是记录，返回空数组即可。 */
export function resolveExpectedFiles(raw: unknown, cwd: string): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) continue;
    seen.add(resolve(cwd, item));
  }
  return [...seen];
}

function stateOf(path: string): FileState {
  try {
    const st = statSync(path);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

/** 命令执行前逐路径快照（审批通过后、真正要跑之前取——审批等待期的用户改动不算命令产出）。 */
export function snapshotExpectedFiles(paths: string[]): ExpectedFilesSnapshot {
  return new Map(paths.map((p) => [p, stateOf(p)]));
}

/** 命令跑完后复核：推导每个申报路径的 op，无变化的丢弃。 */
export function verifyExpectedChanges(
  snapshot: ExpectedFilesSnapshot,
): Array<{ path: string; op: FileChangeOp }> {
  const changes: Array<{ path: string; op: FileChangeOp }> = [];
  for (const [path, before] of snapshot) {
    const after = stateOf(path);
    if (!before.exists && after.exists) changes.push({ path, op: 'create' });
    else if (before.exists && !after.exists) changes.push({ path, op: 'delete' });
    else if (
      before.exists &&
      after.exists &&
      (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
    )
      changes.push({ path, op: 'modify' });
  }
  return changes;
}
