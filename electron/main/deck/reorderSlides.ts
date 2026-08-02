/**
 * 拖拽重排 deck 页面顺序
 *
 * 流程：
 * 1. 防护性 commit（如果 dirty）
 * 2. 抓 before 快照（html + annotations）
 * 3. splitSlides + 按 newOrder 重排 + 写回 index.html
 * 4. 同步更新 annotation.pageIndex（旧 page i → 新 page newOrder.indexOf(i)）
 * 5. push undo entry (kind='reorder', before/after 都有 html + annotations)
 * 6. commitVersion('reorder') —— 内部会 push undo barrier
 * 7. broadcast deck.indexChanged + deck.annotationsChanged
 */
import { promises as fs } from 'node:fs';
import { safeWriteAsync } from '../fs/safeWrite';
import { runExclusive } from '../fs/runExclusive';
import { ErrorCodes, type ErrorCode, type Annotation } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { getDeck } from './store';
import { deckIndexPath, deckLockKey } from './pathResolver';
import { segmentSlidesWithRanges } from './deckModel';
import { readAnnotations, writeAnnotations } from './annotations';
import { commitVersionLocked, isDirty } from './history';
import { flushPendingLocked } from './commitScheduler';
import { push as undoPush } from './undoStack';

type Broadcast = (ev: ServerEvent) => void;

export type ReorderResult =
  | { ok: true; count: number }
  | { ok: false; code: ErrorCode; message: string };

export async function reorderSlides(args: {
  artifactId: string;
  newOrder: number[];
  broadcast: Broadcast;
}): Promise<ReorderResult> {
  const { artifactId, newOrder, broadcast } = args;

  const deck = await getDeck(artifactId);
  if (!deck) {
    return { ok: false, code: ErrorCodes.DECK_NOT_FOUND, message: `deck not found: ${artifactId}` };
  }

  // 整段写 index.html + 版本 commit 进同一把 deckLockKey 锁（与 applyTextEdit/commitVersion 同步序），
  // 消除「重排无锁丢版本」（技术设计 §2.5a）。锁内一律走 *Locked 无锁内核，绝不再嵌套抢同锁（§2.5c）。
  return runExclusive(deckLockKey(deck.path), () => reorderSlidesLocked(args, deck));
}

async function reorderSlidesLocked(
  args: { artifactId: string; newOrder: number[]; broadcast: Broadcast },
  deck: { path: string },
): Promise<ReorderResult> {
  const { artifactId, newOrder, broadcast } = args;

  // 防护性 commit——避免用户外部修改混进 reorder 版本（持锁 → 走 *Locked 变体）
  await flushPendingLocked(artifactId);
  if (await isDirty(artifactId)) {
    await commitVersionLocked(artifactId, 'protective', '用户手动修改（重排前暂存）');
  }

  const beforeHtml = await fs.readFile(deckIndexPath(deck.path), 'utf-8');
  // 切页 + 字节区间走 deckModel 单一来源（不再自抄正则）：区间用来 splice，slides 用来重排。
  const matches = segmentSlidesWithRanges(beforeHtml);
  const slides = matches.map((m) => m.html);

  if (matches.length === 0) {
    return { ok: false, code: ErrorCodes.UNKNOWN, message: 'deck 中没有识别出任何页面，无法重排' };
  }
  if (!isValidPermutation(newOrder, slides.length)) {
    return {
      ok: false,
      code: ErrorCodes.UNKNOWN,
      message: `newOrder 不是 0..${slides.length - 1} 的合法排列`,
    };
  }

  // 重排时保留原始页间间隙（separator 按位置不动）：恒等重排重建出与原文逐字节相同的 HTML，
  // 不再因 '\n' 硬拼制造伪版本变更。gap[i] = 第 i、i+1 页之间的原始文本。
  const prefix = beforeHtml.slice(0, matches[0].start);
  const suffix = beforeHtml.slice(matches[matches.length - 1].end);
  const gaps = matches.slice(0, -1).map((m, i) => beforeHtml.slice(m.end, matches[i + 1].start));
  let afterHtml = prefix;
  newOrder.forEach((oldIdx, pos) => {
    afterHtml += slides[oldIdx];
    if (pos < newOrder.length - 1) afterHtml += gaps[pos];
  });
  afterHtml += suffix;

  await safeWriteAsync(deckIndexPath(deck.path), afterHtml);

  // annotation.pageIndex 重映射：旧 i → 新 newOrder.indexOf(i)
  const beforeAnnotations = await readAnnotations(artifactId);
  const afterAnnotations: Annotation[] = beforeAnnotations.map((a) => {
    const oldPageIndex = a.locator.pageIndex;
    if (typeof oldPageIndex !== 'number') return a; // 非 deck 定位（无页）→ 不动
    const newPageIndex = newOrder.indexOf(oldPageIndex);
    if (newPageIndex < 0) return a; // 越界/陈旧 pageIndex（指向已删页）→ 不动，绝不写 -1
    return newPageIndex === oldPageIndex
      ? a
      : { ...a, locator: { ...a.locator, pageIndex: newPageIndex }, updatedAt: Date.now() };
  });
  await writeAnnotations(artifactId, afterAnnotations);

  // push undo entry 在 commitVersion 之前——commitVersion 内部会 push barrier，让本 entry 落在 barrier 之前
  undoPush(artifactId, {
    kind: 'reorder',
    before: { html: beforeHtml, annotations: beforeAnnotations },
    after: { html: afterHtml, annotations: afterAnnotations },
  });

  await commitVersionLocked(artifactId, 'reorder', `页面重排（${slides.length} 页）`);

  broadcast({ type: 'artifact.indexChanged', artifactId });
  broadcast({ type: 'artifact.annotationsChanged', artifactId, annotations: afterAnnotations });
  return { ok: true, count: slides.length };
}

/** 验证 newOrder 是 0..n-1 的一个合法排列 */
function isValidPermutation(arr: number[], n: number): boolean {
  if (arr.length !== n) return false;
  const seen = new Set<number>();
  for (const v of arr) {
    if (!Number.isInteger(v) || v < 0 || v >= n || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}
