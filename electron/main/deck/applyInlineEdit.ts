/**
 * 行内编辑落盘（Deck 模块）
 *
 * 用户在 webview 内双击文字 → contentEditable → blur 时 preload 把 oldText / newText
 * （编辑前后的 innerHTML）通过 ipc 报上来，main 这边定位并回写 index.html。
 *
 * 定位策略（第一性原则，关键）：
 *   main 进程只有 HTML 字符串、**没有 DOM 解析器**——CSS selector 无法对裸字符串匹配，
 *   preload 现场生成的 m-xxx 只在 DOM、源里没有，所以都不是可靠定位信号。
 *   唯一可靠的信号是 **oldText 子串在源 HTML 里的唯一性**：
 *     · 恰好 1 次 → 替换、写回、commit（无歧义）。
 *     · 0 次（动态渲染 / DOM≠源）→ not-found，拒绝。
 *     · >1 次（文本歧义）→ ambiguous，拒绝。
 *   这正兑现「双击只在 DOM 与源基本一致、且文本能无歧义定位时生效」的降级——
 *   拒绝时前端提示「这块用框选交给 AI 改」。
 *   （这是对 tech §9「selector + oldText 定位」的务实修正：裸字符串上做不到 selector 匹配。）
 *
 * 快路径：Oru 自产 deck 元素源里本就带 data-edit-id，preload 把它带上来时走正则直接定位，
 * 命中即替换——比子串计数更精准（避开同文本歧义）。markerId 缺失 / 未命中再走慢路径。
 *
 * 已知上限：oldText 取自 DOM innerHTML，浏览器规范化后可能与源字节对不上 → 慢路径 0 命中走降级
 * （让用户改用框选）。详尽缘由见内核 fs/applyTextEdit 文件头——定位/快路径/转义的单一出处在那里。
 *
 * 实现：本模块是 fs/applyTextEdit 内核的薄壳——定位/快路径/转义/原子写全在内核，这里只多做
 * deck 专属的版本历史副作用（resolveDeckPath / undo 快照 / commit 调度）。
 */
import { resolveDeckPath } from './store';
import { deckIndexPath } from './pathResolver';
import { push as undoPush } from './undoStack';
import { scheduleInlineEditCommit } from './commitScheduler';
import { applyTextEdit, type ApplyTextEditResult } from '../fs/applyTextEdit';

// reason 是内核 reason 收敛后的对外面：not-found/ambiguous=定位降级，io=写盘失败（conflict 也折进 io）。
export type ApplyInlineEditResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'io'; message: string };

// 从结果类型提取，避免手抄 union 漂移（内核/对外加 reason 时这里编译即报，不假绿）
type KernelReason = Extract<ApplyTextEditResult, { ok: false }>['reason'];
type PublicReason = Extract<ApplyInlineEditResult, { ok: false }>['reason'];

// 内核拒绝 reason → 本模块对外 reason + 中文提示。
// conflict 仅在传 expectedMtimeMs 时产出，deck 不传故永不可达——但内核签名含它，
// 这里显式折成 io（而非把 conflict 漏进对外 union），既类型自洽又不污染 router/前端的 reason 面。
const REASON_MAP: Record<KernelReason, { reason: PublicReason; message: string }> = {
  'not-found': { reason: 'not-found', message: '源 HTML 里找不到这段文本（可能是动态渲染）' },
  ambiguous: { reason: 'ambiguous', message: '这段文本在页面出现多次，无法无歧义定位' },
  io: { reason: 'io', message: '写入 index.html 失败' },
  conflict: { reason: 'io', message: '写入 index.html 失败' },
};

export async function applyInlineEdit(args: {
  artifactId: string;
  markerId?: string | null;
  oldText: string;
  newText: string;
  pageIndex: number;
}): Promise<ApplyInlineEditResult> {
  let deckPath: string;
  try {
    deckPath = await resolveDeckPath(args.artifactId);
  } catch {
    return { ok: false, reason: 'io', message: `deck not found: ${args.artifactId}` };
  }
  const indexPath = deckIndexPath(deckPath);

  // 定位/快路径/转义/原子写全在内核（fs/applyTextEdit）：deck 是 Oru 托管作品不做外部冲突校验，
  // 故不传 expectedMtimeMs。returnHtml 让内核锁内回传写盘前后全文，供下面的 undo 快照（原子、无 TOCTOU）。
  const r = await applyTextEdit({
    filePath: indexPath,
    markerId: args.markerId,
    oldText: args.oldText,
    newText: args.newText,
    returnHtml: true,
  });

  if (!r.ok) {
    const { reason, message } = REASON_MAP[r.reason];
    return { ok: false, reason, message };
  }

  // undo 重放整页 before/after HTML（内核锁内回传的实际写盘字节），不依赖 marker；
  // meta.markerId 有就放（仅 UI 显示用）。returnHtml:true 保证 before/after 必有值。
  undoPush(args.artifactId, {
    kind: 'inline-edit',
    before: { html: r.before! },
    after: { html: r.after! },
    meta: { pageIndex: args.pageIndex, ...(args.markerId ? { markerId: args.markerId } : {}) },
  });

  scheduleInlineEditCommit(args.artifactId, args.pageIndex);

  return { ok: true };
}
