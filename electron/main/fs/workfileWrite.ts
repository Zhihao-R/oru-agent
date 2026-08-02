/**
 * commitWorkfileWrite —— 工作文件落盘的统一临界区（md / csv / AI 写都走它）。
 *
 * 一次进 per-workfile 锁（key = 工作文件**规范化**绝对路径 = FileHistory 的 fileKey），整段原子（技术设计 §2.5b）：
 *   1. 读磁盘当前版；调用方带 baseline / expectAbsent 时先做锁内校验（S02 · G88，见 CommitResult），
 *      不满足即拒写出锁——「不错」靠它。
 *   2. 把当前版交给 FileHistory.snapshot('overwrite-guard')——内部按 lastHash 单一真相源判定，
 *      若 cur 是「还没进过历史的版本」（别人在我之前落、我没见过的）就先兜进历史，否则 no-op。
 *      这是「不丢」的承重机制：任何曾落盘的版本在被覆盖前都先进历史，与基线校验互补、不互替。
 *   3. 原子写我的内容（不带 baseline 的调用方仍是 last-writer-wins）。
 *   4. 可选：给「我的版本」打一个事件标（'ai' / 'manual'），让历史里能看到「谁在某刻动了这里」。
 *
 * 锁 key / fileKey 一律走 resolve() 规范化——用户侧（ensureWithinProject 已 resolve）与 AI 侧（模型给的原始
 * 绝对路径，可能含 ./ ../ 重复斜杠）必须归一到同一字面，否则同一文件被劈成两把锁 / 两个历史目录，
 * 「用户落盘 ↔ AI 写不丢」直接漏抓（review C-1）。
 *
 * 读盘一律走 readWithMetaAsync（BOM/CRLF 归一 + 异步不阻塞 event loop），与「写出的 LF 内容」hash 口径一致：
 * CRLF/BOM 文件下也不会因「raw 读 vs 归一读」两套 hash 域而让 lastHash 单一真相源失真（review M-1）。
 *
 * 必须放在 FileHistory 之外：fileHistory 模块禁止抢 workfile 锁（§2.2 锁方向单向不变量），
 * 这里才是「workfile 锁 → history 小锁」的发起方。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runExclusive } from './runExclusive';
import { safeWriteAsync, readWithMetaAsync, type LineEnding } from './safeWrite';
import * as fileHistory from './fileHistory';
import type { SnapshotKind } from './fileHistory';
import { touchSampling } from './historySampler';
import { diff3 } from '@shared/diff3';

/**
 * 锁内校验的结构化结果（S02 · G88 定形，S27 扩合并两态）。rejected 时磁盘一字未动。
 * - `merged`：mergeOnStale 调用方基线过期、双方改**不同段**——锁内 diff3 合并后已写入合并产物（携内容）。
 * - `discarded`：mergeOnStale 且撞**同段**——弃写出锁、磁盘一字未动，在途内容降级由执行器/S29 接手。
 * 形状定死，下游（S28 换笔可见、S29 冲突卡收口）只加消费、不改语义。
 */
export type CommitResult =
  | { status: 'written' }
  | { status: 'merged'; content: string }
  | { status: 'rejected'; reason: 'baseline-mismatch' | 'path-occupied' | 'discarded' };

export async function commitWorkfileWrite(args: {
  /** 工作文件绝对路径（内部 resolve 规范化后作 runExclusive key = FileHistory fileKey） */
  absPath: string;
  content: string;
  lineEnding?: LineEnding;
  /**
   * S28（G91）这次落盘的笔：'user'=用户落盘、'ai'=AI 落盘。guardOverwrite 据它判「换笔」——覆盖别人写的
   * 版本时把被覆盖版打可见的 'handoff' 标（时间轴可找回），并记下最新磁盘版作者供下次判定。
   * 缺省 'user'（写盘绝大多数是用户笔）；**AI 写入路径必须显式传 'ai'**，否则换笔判定漏判、AI 覆盖用户版
   * 不再可见找回。当前唯一 AI 入口 executeFileWriteProposal 已显式传 'ai'（AI 写入经 S02 收口到此单一执行器）。
   */
  by?: 'user' | 'ai';
  /** 写后给「我的版本」打的事件标；不传则只兜底覆盖前的版本、不为我的版本单独留底 */
  mark?: Extract<SnapshotKind, 'ai' | 'manual'>;
  /**
   * 锁内基线校验（G88）：要求磁盘当前版逐字等于 baseline.content（LF 归一口径），
   * 否则拒写返回 baseline-mismatch——含「文件已消失」（读过的认知已过期，同样退回）。
   */
  baseline?: { content: string };
  /**
   * S27 锁内机械合并（G87）：基线过期时不直接拒写，先以磁盘现状为 theirs 试三方合并——
   * 不同段自动合并写入返回 merged、撞同段弃写返回 discarded。仅编辑器侧的笔（实时保存/合并落盘）传，
   * AI 侧不传（其基线过期只有「出锁重读」一个出口）。要求同时带 baseline。
   */
  mergeOnStale?: boolean;
  /** 新建语义（G3 第三项核对）：要求目标路径仍空着，被占则拒写返回 path-occupied。 */
  expectAbsent?: boolean;
}): Promise<CommitResult> {
  const key = resolve(args.absPath);
  const { content, lineEnding = 'LF', mark, by = 'user' } = args;
  const result = await runExclusive(key, async (): Promise<CommitResult> => {
    const exists = existsSync(key);
    if (args.expectAbsent && exists) return { status: 'rejected', reason: 'path-occupied' };
    if (exists) {
      const cur = (await readWithMetaAsync(key)).content; // 归一口径，与写出内容 hash 一致
      if (args.baseline && cur !== args.baseline.content) {
        // 基线过期：mergeOnStale 调用方走锁内机械合并（C1 的病根是「读—合并—写」跨渲染端不原子，
        // 这里以磁盘现状 cur 为 theirs 一次算完），其余调用方（AI）照旧拒写退回重读。
        if (!args.mergeOnStale) return { status: 'rejected', reason: 'baseline-mismatch' };
        const { merged, conflicts } = diff3(args.baseline.content, content, cur);
        if (conflicts.length > 0) return { status: 'rejected', reason: 'discarded' }; // 撞同段：一字不写
        await fileHistory.guardOverwrite(key, cur, by); // 覆盖 cur（可能含 AI 刚落版）前先兜进历史，换笔则可见
        await safeWriteAsync(key, merged, lineEnding);
        if (mark) await fileHistory.snapshot(key, mark, merged);
        return { status: 'merged', content: merged };
      }
      await fileHistory.guardOverwrite(key, cur, by);
    } else if (args.baseline) {
      // 带基线 = 调用方声称读过此文件；文件已不在 → 认知过期，退回重读
      return { status: 'rejected', reason: 'baseline-mismatch' };
    } else {
      await fileHistory.guardOverwrite(key, null, by); // 新建：无前版可兜，仅记下作者供下次换笔判定
    }
    await safeWriteAsync(key, content, lineEnding);
    if (mark) await fileHistory.snapshot(key, mark, content);
    return { status: 'written' };
  });
  if (result.status === 'written' || result.status === 'merged') {
    touchSampling(key); // 告诉周期取样器这一周期有新编辑（仅对已注册的活跃文件有效）
  }
  return result;
}

/**
 * 局部编辑落盘（AI edit_file 路径）：read-apply-write 整段在同一把 workfile 锁内做，
 * 消除「锁外读旧内容算 updated、锁内才写」的 TOCTOU（用户在缝隙里改了文件会被 stale 编辑盖掉）。
 * 锁内：先把当前版兜进历史（overwrite-guard），再对当前内容做变换写回，再给我的版本打 'ai' 标。
 * apply 收 LF 归一内容、返回 LF 归一新内容；落盘还原文件原本换行风格。返回写出的新内容。
 */
export async function commitWorkfileEdit(args: {
  absPath: string;
  apply: (current: string) => string; // 锁内对当前内容做变换（applyEdit 等）
  mark?: Extract<SnapshotKind, 'ai'>;
}): Promise<string> {
  const key = resolve(args.absPath);
  const { apply, mark } = args;
  const updated = await runExclusive(key, async () => {
    const { content, lineEnding } = await readWithMetaAsync(key);
    await fileHistory.guardOverwrite(key, content, 'ai'); // AI 局部编辑：覆盖前兜底，换笔（你写的→AI 改）则可见
    const next = apply(content);
    await safeWriteAsync(key, next, lineEnding);
    if (mark) await fileHistory.snapshot(key, mark, next);
    return next;
  });
  touchSampling(key);
  return updated;
}

/**
 * 弃写降级入历史（S27 交付接口 / S29 触发）：撞同段被 discarded、又无编辑器接住其在途内容时，把这份
 * 在途内容降级写进历史打 'discarded' 标（可找回、抗 GC 稀释、对用户可见）——只加一条历史快照、不碰磁盘
 * 文件。进 workfile 锁保证与落盘有序（不丢承诺的地基）。S27 不调用它：触发判定「无编辑器打开」属冲突卡
 * 生命周期、归 S29；此处只定死接口与快照种类，避免两 session 双头实施同一行为（tech §7）。
 */
export async function recordDiscardedContent(absPath: string, content: string): Promise<void> {
  const key = resolve(absPath);
  await runExclusive(key, async () => {
    await fileHistory.snapshot(key, 'discarded', content);
  });
}

/**
 * 把某旧快照整篇恢复回工作文件。workfile 锁内：先把当前版留底（pre-restore，防恢复也丢），
 * 再从 FileHistory 取回旧内容写回。返回恢复后的内容，供渲染端更新编辑器。
 */
export async function restoreWorkfileSnapshot(
  absPath: string,
  snapshotId: string,
  /**
   * 锁内前置校验：要求磁盘当前内容 hash 逐字等于它，否则一字不写、抛 WORKFILE_RESTORE_STALE。
   * 调用方在锁外算出的「可以恢复」结论跨过 await 就可能过期（CLAUDE.md·并发），承重判断锁内重做——
   * 记忆卡撤回靠它兜住「校验完到执行前档案又被写了一次」的窗口。
   */
  opts?: { expectCurrentHash?: string },
): Promise<string> {
  const key = resolve(absPath);
  const content = await runExclusive(key, async () => {
    if (existsSync(key)) {
      const cur = (await readWithMetaAsync(key)).content;
      if (opts?.expectCurrentHash !== undefined && fileHistory.contentHash(cur) !== opts.expectCurrentHash) {
        const err = new Error('workfile changed since the restore was decided') as Error & { code?: string };
        err.code = 'WORKFILE_RESTORE_STALE';
        throw err;
      }
      await fileHistory.snapshot(key, 'pre-restore', cur);
    } else if (opts?.expectCurrentHash !== undefined) {
      const err = new Error('workfile is gone') as Error & { code?: string };
      err.code = 'WORKFILE_RESTORE_STALE';
      throw err;
    }
    const restored = await fileHistory.restore(key, snapshotId);
    await safeWriteAsync(key, restored, 'LF');
    // 恢复是用户动作：把「当前磁盘版作者」记为 user——否则 lastAuthor 停在恢复前的值（如 'ai'），
    // 用户随后自己编辑保存会被误判换笔、给自己刚恢复的版本打虚假 handoff（S28 review·Major）。
    // 前版已由 pre-restore 兜底，故传 cur=null（只推进作者、不再兜）。
    await fileHistory.guardOverwrite(key, null, 'user');
    return restored;
  });
  touchSampling(key);
  return content;
}
