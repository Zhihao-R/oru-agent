/**
 * applyTextEdit —— 文件级文字写回内核。
 *
 * 定位逻辑原样搬自 deck/applyInlineEdit.ts（main 进程只有 HTML 字符串、无 DOM 解析器，
 * 唯一可靠信号是 oldText 子串在源里的唯一性；Oru 自产元素带 data-edit-id 走正则快路径）：
 *   - markerId 非空 → data-edit-id 正则快路径，命中即替换该元素 inner；未命中不报错，落慢路径靠 oldText 唯一性兜底
 *   - 否则（或快路径未命中）按 oldText 出现次数：1 替换 / 0 not-found / >1 ambiguous
 *   - 替换串做 $ 转义，让用户文本里的 $&/$1 字面写入，不被当替换模式展开
 *
 * 与 applyInlineEdit 的差异（本内核更通用）：
 *   - 作用于任意 filePath，不绑 deck artifact / undo / commit 调度
 *   - 整块读-定位-写包进 runExclusive(resolve(filePath)) 串行锁（与 workfileWrite 同口径），挡同文件并发写丢更新
 *   - 可选 expectedMtimeMs 基线：传了且当前 mtime 不符 → conflict（deck 不传，跳过校验）
 *
 * deck/applyInlineEdit 已是本内核的薄壳——定位/快路径/转义是这里的单一出处，行为不能漂移。
 */
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { safeWriteAsync, normalizeDecoded } from './safeWrite';
import { runExclusive } from './runExclusive';
import * as fileHistory from './fileHistory';
import type { SnapshotKind } from './fileHistory';

export type ApplyTextEditResult =
  // returnHtml 时成功变体带写盘前/后全文——锁内取得，调用方据此做 undo 快照（详见下方 returnHtml 说明）
  | { ok: true; before?: string; after?: string }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'conflict' | 'io' };

export async function applyTextEdit(args: {
  filePath: string;
  markerId?: string | null;
  oldText: string;
  newText: string;
  /** 基线 mtime（Math.floor 毫秒）；缺省跳过冲突校验（deck 不传） */
  expectedMtimeMs?: number;
  /**
   * 要回写盘前后全文：成功时返回 { ok, before, after }，二者就是锁内读到/写出的字节，
   * 与磁盘内容一致且原子（无 TOCTOU）。deck 壳要它做 undo 快照；HTML 侧不需要可省（默认 false）。
   */
  returnHtml?: boolean;
  /**
   * S28（G91/G39）旁路写入的笔：传了走 guardOverwrite（换笔则被覆盖版打可见 handoff 标 + 记作者），
   * 不传保持原 overwrite-guard 兜底（deck 行内改字走自己的版本提交，不接管作者/换笔，故 deck 壳不传）。
   */
  by?: 'user' | 'ai';
  /**
   * S28（G39）：写后给「我的新内容」打一个可见事件标——旁路写入（预览右键改字）落盘后在时间轴上认得出、
   * 点得回。deck 壳不传（deck 另有 inline 版本提交，避免重复入库）。
   */
  visibleMark?: Extract<SnapshotKind, 'manual'>;
}): Promise<ApplyTextEditResult> {
  // 锁 key 必须 resolve 归一——与 fs/workfileWrite 的 runExclusive(resolve(absPath)) 同口径，
  // 否则同一文件以 './a.html' vs 绝对路径写会落两把不同的锁、互不串行 → 丢更新。
  const filePath = resolve(args.filePath);
  // 整块读-定位-写入锁：同文件并发编辑串行，避免后写覆盖前写（详 CLAUDE.md「await 后重检共享状态」）
  return runExclusive(filePath, async () => {
    // 先 read 再 stat：两次 await 间有让出窗口，外部进程可能此时改文件。read 在前保证 stat 的 mtime
    // 永远「不旧于」我们读到的内容——外部若在读前改过，stat（读之后）会看到更新 mtime → 正确判 conflict；
    // 最坏只偶发保守误判 conflict（安全），绝不漏判后改错文件。无 fd 锁下这是可接受上限。
    let beforeHtml: string;
    let mtimeMs: number;
    try {
      beforeHtml = await fs.readFile(filePath, 'utf-8');
      const stat = await fs.stat(filePath);
      mtimeMs = Math.floor(stat.mtimeMs);
    } catch {
      return { ok: false, reason: 'io' };
    }

    // 传了基线且不符 → 文件已被改过，拒绝（不触碰文件）
    if (args.expectedMtimeMs !== undefined && mtimeMs !== args.expectedMtimeMs) {
      return { ok: false, reason: 'conflict' };
    }

    let afterHtml: string | null = null;

    if (args.markerId) {
      // ── 快路径：按 data-edit-id 正则定位整段 inner 替换 ──
      // group 1 = 开标签，group 2 = tag name（反向引用闭合），group 3 = inner，group 4 = 闭标签
      const re = new RegExp(
        `(<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bdata-edit-id=(?:"${escapeReg(args.markerId)}"|'${escapeReg(args.markerId)}'|${escapeReg(args.markerId)})[^>]*>)([\\s\\S]*?)(<\\/\\2>)`,
        'i',
      );
      if (re.test(beforeHtml)) {
        // $1/$4 是刻意保留的捕获组引用，故不转义；newText 是用户输入须转义 $，否则 $&/$1 会被展开损坏内容
        afterHtml = beforeHtml.replace(re, `$1${escapeReplacement(args.newText)}$4`);
      }
      // 快路径未命中不报错——afterHtml 保持 null，落到下面慢路径靠 oldText 唯一性兜底（与 applyInlineEdit 同构）
    }

    // ── 慢路径：按 oldText 子串唯一性定位（用 split 数次数，oldText 含正则元字符不炸） ──
    if (afterHtml === null) {
      if (args.oldText.length === 0) {
        return { ok: false, reason: 'not-found' };
      }
      const count = beforeHtml.split(args.oldText).length - 1;
      if (count === 0) return { ok: false, reason: 'not-found' };
      if (count > 1) return { ok: false, reason: 'ambiguous' };
      // 搜索串是字符串参数（只替换首个、无需正则转义）；替换串里用户输入的 $ 须转义
      afterHtml = beforeHtml.replace(args.oldText, escapeReplacement(args.newText));
    }

    // 覆盖前快照（块④：补缺陷② 右键改字不进历史）——把磁盘当前版兜进 FileHistory，
    // 与 commitWorkfileWrite 的兜底同一道、同一 fileKey（filePath 已 resolve）、同 history 小锁，
    // 方向仍是 workfile 锁 → history 小锁（本块已在 runExclusive(filePath) 内）。lastHash 单一真相源去重，
    // 同一版无论被「右键自己的兜底」还是「随后内核覆盖的兜底」触达只存一次（连续右键的中间版也不再丢）。
    // 快照内容走内核同一个 normalizeDecoded（剥 BOM + CRLF→LF），与 readWithMetaAsync 同口径不分裂 hash 域。
    const beforeNorm = normalizeDecoded(beforeHtml);
    if (args.by) await fileHistory.guardOverwrite(filePath, beforeNorm, args.by); // G91：换笔则被覆盖版可见
    else await fileHistory.snapshot(filePath, 'overwrite-guard', beforeNorm); // deck 壳：原兜底、不接管作者

    try {
      await safeWriteAsync(filePath, afterHtml);
    } catch {
      return { ok: false, reason: 'io' };
    }
    // G39：旁路写入落盘后给新内容打可见标（时间轴上认得出）；deck 壳不传 visibleMark（另有 inline 提交）。
    if (args.visibleMark) await fileHistory.snapshot(filePath, args.visibleMark, normalizeDecoded(afterHtml));
    return args.returnHtml ? { ok: true, before: beforeHtml, after: afterHtml } : { ok: true };
  });
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 转义 String.replace 替换串里的 $ —— 让用户文本里的 $ 字面输出，不被当 $&/$1 等模式展开
function escapeReplacement(s: string): string {
  return s.replace(/\$/g, '$$$$');
}
