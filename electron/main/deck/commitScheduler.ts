/**
 * 30s 防抖 commit 调度
 *
 * 行内编辑场景：用户连续敲字符 → 不是每按一下都 commit，而是最后一次编辑后 30s 落一版。
 * 切 deck / 退出 app / AI 介入前 → flushPending 强制落。
 *
 * 详 tech doc §7.4 / §7.5
 */
import { commitVersion, commitVersionLocked } from './history';

/** 防抖延迟；初始 30s，参数化（PRD §4 第 142 行实测后可调） */
export const PENDING_DELAY_MS = 30_000;

type Pending = {
  timer: NodeJS.Timeout;
  /** 累积修改过的 pageIndex 集合，用于 summary 派生 */
  pages: Set<number>;
};

const pending = new Map<string, Pending>();

/**
 * 排一次行内编辑 commit。30s 内再次调用 → 重置计时器、累积 pageIndex。
 * commit 触发时 summary 派生在 runCommit 内直接拼，不外露 caller hook。
 */
export function scheduleInlineEditCommit(artifactId: string, pageIndex: number): void {
  const existing = pending.get(artifactId);
  const pages = existing?.pages ?? new Set<number>();
  pages.add(pageIndex);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    void runCommit(artifactId, false); // 定时器触发时不持锁 → 走锁壳
  }, PENDING_DELAY_MS);
  pending.set(artifactId, { timer, pages });
}

/**
 * 立刻 flush 一个 deck 的 pending commit（**锁壳**）；没 pending 是 no-op。
 * 切 deck / 退出 app / AI 介入前调——caller 不持 indexPath 锁时用这个。
 */
export async function flushPending(artifactId: string): Promise<void> {
  const existing = pending.get(artifactId);
  if (!existing) return;
  clearTimeout(existing.timer);
  await runCommit(artifactId, false);
}

/**
 * 同 flushPending，但供**已持 indexPath 锁**的 caller（如 reorderSlides 整段入锁）调用——
 * 走无锁内核 commitVersionLocked，绝不再抢同一把锁（否则锁内等自己＝自死锁，技术设计 §2.5c）。
 */
export async function flushPendingLocked(artifactId: string): Promise<void> {
  const existing = pending.get(artifactId);
  if (!existing) return;
  clearTimeout(existing.timer);
  await runCommit(artifactId, true);
}

/** 是否有该 deck 的 pending commit；让 main 在 AI 介入 / 退出前判断是否要 flush */
export function hasPending(artifactId: string): boolean {
  return pending.has(artifactId);
}

/** 退出前 flush 所有 deck 的 pending commit——否则最后 30s 的行内编辑不入版本历史即丢失 */
export async function flushAllPending(): Promise<void> {
  const ids = Array.from(pending.keys());
  await Promise.all(ids.map((id) => flushPending(id)));
}

/** 仅测试用：清空所有 pending 不 flush（避免 smoke 残留计时器） */
export function __resetForTest(): void {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
}

async function runCommit(artifactId: string, locked: boolean): Promise<void> {
  const snapshot = pending.get(artifactId);
  if (!snapshot) return;
  pending.delete(artifactId);
  const pageList = Array.from(snapshot.pages).sort((a, b) => a - b);
  const summary = `行内编辑：第 ${pageList.map((p) => p + 1).join(', ')} 页`;
  try {
    // 持锁 caller 走无锁内核，不持锁 caller 走锁壳——同一段 commit 逻辑、两条入口（技术设计 §2.5c）
    if (locked) await commitVersionLocked(artifactId, 'inline', summary);
    else await commitVersion(artifactId, 'inline', summary);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[deck.commitScheduler] commit failed for ${artifactId}:`, e);
  }
}
