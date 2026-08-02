/**
 * 表格键盘操作的判定内核 —— 「当前选区 + 一次按键」→「要做什么」，纯函数不碰 DOM 不碰 store。
 *
 * 坐标全是**显示序**（排序筛选后的行号）：用户看到什么就移到哪。转文件行号是调用方的事。
 *
 * 方向键从**焦点**（r2c2）而非锚点移动——用户最后放开鼠标的地方就是他当前关注的地方，
 * 且这样按不按 Shift 只差「塌不塌缩」这一件事，两条路径的心智模型是同一个。
 * （Excel 从锚点移动；这里不照搬，理由如上。）
 */
import type { TableSelection } from '@/lib/tableSelection';

export type TableKeyAction =
  | { kind: 'select'; sel: TableSelection }
  /** initial=null → 保留原值进编辑（⌃U/F2）；否则以该字符覆盖后进编辑（直接打字） */
  | { kind: 'edit'; row: number; col: number; initial: string | null }
  /** 清空当前选区。不带坐标：与剪切共用同一段清空逻辑，而剪切要在 await 之后重读选区 */
  | { kind: 'clear' }
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' };

export type TableKeyContext = {
  selection: TableSelection;
  /** 当前视图的可见行数（= displayIdx.length），不是文件总行数 */
  rowCount: number;
  colCount: number;
  /** 超限只读 / 格式转换确认框开着：移动与复制放行，写类动作一律挡掉 */
  readonly: boolean;
  editing: boolean;
};

type KeyLike = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean };

const clamp = (v: number, max: number): number => Math.max(0, Math.min(v, max));
const single = (r: number, c: number): TableSelection => ({ kind: 'range', r1: r, c1: c, r2: r, c2: c });

/** 选区的焦点端（方向键与扩选都从这里出发）；列选区与空选区回落到左上角。 */
function focusOf(sel: TableSelection): { r: number; c: number } {
  if (!sel) return { r: 0, c: 0 };
  if (sel.kind === 'col') return { r: 0, c: sel.col };
  return { r: sel.r2, c: sel.c2 };
}

function anchorOf(sel: TableSelection): { r: number; c: number } {
  if (!sel) return { r: 0, c: 0 };
  if (sel.kind === 'col') return { r: 0, c: sel.col };
  return { r: sel.r1, c: sel.c1 };
}

const ARROWS: Record<string, { dr: number; dc: number }> = {
  ArrowUp: { dr: -1, dc: 0 },
  ArrowDown: { dr: 1, dc: 0 },
  ArrowLeft: { dr: 0, dc: -1 },
  ArrowRight: { dr: 0, dc: 1 },
};

/**
 * 返回 null = 本 handler 不处理，放行给浏览器/输入框。
 *
 * 编辑态**整体放行**：格内输入框自己管方向键、Enter、Escape，以及 ⌘C/⌘X/⌘V——
 * 用户在格子里想复制光标处一段文字，不能被整表级的块复制顶替。
 */
export function resolveTableKey(e: KeyLike, ctx: TableKeyContext): TableKeyAction | null {
  if (ctx.editing) return null;
  if (ctx.rowCount === 0 || ctx.colCount === 0) return null;

  const mod = e.metaKey || e.ctrlKey;
  const maxR = ctx.rowCount - 1;
  const maxC = ctx.colCount - 1;
  const focus = focusOf(ctx.selection);
  const anchor = anchorOf(ctx.selection);

  if (mod) {
    switch (e.key) {
      case 'a':
      case 'A':
        return { kind: 'select', sel: { kind: 'range', r1: 0, c1: 0, r2: maxR, c2: maxC } };
      case 'c':
      case 'C':
        return ctx.selection ? { kind: 'copy' } : null;
      // 整列选区只支持复制：剪切要清空、粘贴要落点，两者对「一整列」都没有定义，
      // 而组件侧的 clearSelection/doPaste 本就对 col 选区 no-op——不在这里挡住，
      // ⌘X 会把数据写进剪贴板却不清空源，静默降级成一次复制。整列的增删走右键菜单。
      case 'x':
      case 'X':
        return ctx.selection && ctx.selection.kind !== 'col' && !ctx.readonly ? { kind: 'cut' } : null;
      case 'v':
      case 'V':
        return ctx.selection && ctx.selection.kind !== 'col' && !ctx.readonly ? { kind: 'paste' } : null;
      case 'u':
      case 'U':
        // ⌃U = 进编辑并保留原值。macOS 上 F2 默认是亮度键，只配 F2 等于这个入口按不出来，
        // 故以 ⌃U 为主键位（Excel for Mac 同款取舍），F2 见下方作别名。只认 ⌃、不认 ⌘。
        if (!e.ctrlKey || ctx.readonly || !ctx.selection) return null;
        return { kind: 'edit', row: focus.r, col: focus.c, initial: null };
      default:
        return null; // ⌘S / ⌘Z 等留给 window 层
    }
  }

  const arrow = ARROWS[e.key];
  const isMove = Boolean(arrow) || e.key === 'Tab' || e.key === 'Enter';
  // 还没有选区时，第一次按移动键落在左上角——而不是从假想的 (0,0) 再走一步、把左上角跳过去
  if (isMove && !ctx.selection) return { kind: 'select', sel: single(0, 0) };

  if (arrow) {
    const r = clamp(focus.r + arrow.dr, maxR);
    const c = clamp(focus.c + arrow.dc, maxC);
    // Shift 扩选：锚点不动，只挪焦点
    if (e.shiftKey) return { kind: 'select', sel: { kind: 'range', r1: anchor.r, c1: anchor.c, r2: r, c2: c } };
    return { kind: 'select', sel: single(r, c) };
  }

  if (e.key === 'Tab') {
    // 行尾折到下一行首；表尾最后一格不折出表（原地不动）
    let r = focus.r;
    let c = focus.c;
    if (!e.shiftKey) {
      if (c < maxC) c += 1;
      else if (r < maxR) {
        c = 0;
        r += 1;
      }
    } else if (c > 0) {
      c -= 1;
    } else if (r > 0) {
      c = maxC;
      r -= 1;
    }
    return { kind: 'select', sel: single(r, c) };
  }

  if (e.key === 'Enter') {
    const r = clamp(focus.r + (e.shiftKey ? -1 : 1), maxR);
    return { kind: 'select', sel: single(r, focus.c) };
  }

  if (e.key === 'Escape') return { kind: 'select', sel: null };

  if (!ctx.selection) return null;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (ctx.readonly || ctx.selection.kind === 'col') return null; // 整列有自己的删除入口
    return { kind: 'clear' };
  }

  if (e.key === 'F2') {
    return ctx.readonly ? null : { kind: 'edit', row: focus.r, col: focus.c, initial: null };
  }

  // 可打印字符 → 进编辑并以该字符覆盖原值。修饰键组合已在上面拦掉，这里只剩裸键。
  if (e.key.length === 1 && !e.altKey) {
    return ctx.readonly ? null : { kind: 'edit', row: focus.r, col: focus.c, initial: e.key };
  }

  return null;
}
