/**
 * Undo / Redo 副作用应用（Deck 模块 v1）
 *
 * Router 流程：peekUndo → applyUndo → 成功才 undo() 消费栈 → broadcast
 * 副作用失败时栈状态保持一致——不会"撤销了但内容没变"。
 *
 * 数据建模统一后这里就是"按 snapshot 字段写盘"的两行：
 *   if (snapshot.html) writeFile
 *   if (snapshot.annotations) writeAnnotations
 *
 * Redo 不支持 = entry.after 缺省（subagent 改动）—— 单独检查抛友好错。
 */
import type { UndoEntry, UndoStateSnapshot } from './undoStack';
import { safeWriteAsync } from '../fs/safeWrite';
import { resolveDeckPath } from './store';
import { deckIndexPath } from './pathResolver';
import { writeAnnotations } from './annotations';

export type ApplyResult =
  | { ok: true; needIndexReload: boolean; needAnnotationsReload: boolean }
  | { ok: false; reason: string };

export async function applyUndo(artifactId: string, entry: UndoEntry): Promise<ApplyResult> {
  if (entry.kind === 'barrier') {
    // peek 已过滤——理论上不会到这里
    return { ok: false, reason: 'barrier-blocked' };
  }
  return applySnapshot(artifactId, entry.before);
}

export async function applyRedo(artifactId: string, entry: UndoEntry): Promise<ApplyResult> {
  if (entry.kind === 'barrier') {
    return { ok: false, reason: 'barrier-in-redo-stack' };
  }
  if (!entry.after) {
    return { ok: false, reason: 'subagent-redo-unsupported' };
  }
  return applySnapshot(artifactId, entry.after);
}

// ─── 内部 ────────────────────────────────────────────────────────

async function applySnapshot(
  artifactId: string,
  snapshot: UndoStateSnapshot,
): Promise<ApplyResult> {
  const needIndexReload = snapshot.html != null;
  const needAnnotationsReload = snapshot.annotations != null;
  if (snapshot.html != null) {
    const deckPath = await resolveDeckPath(artifactId);
    await safeWriteAsync(deckIndexPath(deckPath), snapshot.html);
  }
  if (snapshot.annotations != null) {
    await writeAnnotations(artifactId, snapshot.annotations);
  }
  return { ok: true, needIndexReload, needAnnotationsReload };
}
