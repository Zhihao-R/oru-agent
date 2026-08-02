import { create } from 'zustand';
import { relocateUnder, isUnder } from '@/lib/paths';
import { registerTabCloser } from '@/stores/workspaceStore';

/**
 * PDF 查看器视图态桶（PDF tech design §四）——按 ref（项目相对 path）分桶，切走保留、切回如初。
 *
 * 与 htmlAnnotStore 只借「byRef 分桶 + closer 注册」骨架，**纯同步**：无 WS 调用、无异步 activate、
 * 无同一性守卫（PDF 只读、无标注/提交/对比态）。方法名按 PDF 自身语义定（open/close，非 activate/deactivate）。
 *
 * 视图态收进 store 而非组件 useState：keep-mounted 下组件虽不卸载，但收进桶与 editor/table/html 一致，
 * 且 relocate 时态随桶迁移不丢。
 */
export type PdfSearchMatch = {
  pageIndex: number; // 0-based
  offset: number; // 命中在该页拼接文本（items.str join）里的字符偏移
  occInPage: number; // 该命中在本页内是第几个（0-based）——active span 按出现序号定位，避免 offset↔span 口径漂移
};

export type PdfSearchState = {
  open: boolean;
  query: string;
  matches: PdfSearchMatch[];
  activeIndex: number; // matches 内当前命中下标，无命中为 -1
};

export type PdfFileState = {
  /** 该 PDF 绝对路径——拼 oru-doc-pdf:// URL 用（同 htmlAnnot 的 absPath 用途）。 */
  absPath: string;
  scrollTop: number;
  zoom: number; // 1 = 100%
  fitWidth: boolean; // true 时随窗格宽重排
  search: PdfSearchState;
};

function emptySearch(): PdfSearchState {
  return { open: false, query: '', matches: [], activeIndex: -1 };
}

function emptyFileState(absPath: string): PdfFileState {
  return { absPath, scrollTop: 0, zoom: 1, fitWidth: true, search: emptySearch() };
}

type PdfState = {
  byRef: Record<string, PdfFileState>; // 按 ref（项目相对 path）分桶

  /** 打开 PDF：同步建桶（无 await/无 WS）。重开已存在的 ref 保留现场、不重置。 */
  open(ref: string, absPath: string): void;
  /** 关闭/切走：删该桶（只读、无未落盘内容，不 flush）。 */
  close(ref: string): void;

  /** 更新某桶视图态（滚动/缩放/搜索）——桶不在则忽略（已关/未开）。 */
  patch(ref: string, p: Partial<PdfFileState>): void;

  /** 打开的 PDF 被改名/移动 → 桶 key + absPath 跟随（与 htmlAnnot.relocate 同形）。 */
  relocate(oldRel: string, newRel: string): void;
  /** 打开的 PDF（或其所在目录）被删 → 删对应桶。 */
  closeIfUnder(path: string): void;
};

export const usePdfStore = create<PdfState>((set, get) => ({
  byRef: {},

  open(ref, absPath) {
    const existing = get().byRef[ref];
    if (existing && existing.absPath === absPath) return; // 桶已存在且同一文件 → 保留现场直接返回（标签切换由 caller 管）
    set({ byRef: { ...get().byRef, [ref]: emptyFileState(absPath) } }); // 首开或 absPath 变（项目根移动）→ 建/重建桶
  },

  close(ref) {
    const byRef = { ...get().byRef };
    delete byRef[ref];
    set({ byRef });
  },

  patch(ref, p) {
    const cur = get().byRef[ref];
    if (!cur) return;
    set({ byRef: { ...get().byRef, [ref]: { ...cur, ...p } } });
  },

  relocate(oldRel, newRel) {
    const byRef = get().byRef;
    const nextByRef: Record<string, PdfFileState> = {};
    let changed = false;
    for (const [ref, f] of Object.entries(byRef)) {
      const next = relocateUnder(ref, oldRel, newRel);
      if (next === null || next === ref) {
        nextByRef[ref] = f;
        continue;
      }
      changed = true;
      // absPath 末尾恰是旧 ref（projectRoot + ref 派生）——整段相对部分换成迁移后的 ref。
      const nextAbs = f.absPath.slice(0, f.absPath.length - ref.length) + next;
      nextByRef[next] = { ...f, absPath: nextAbs };
    }
    if (changed) set({ byRef: nextByRef });
  },

  closeIfUnder(path) {
    for (const ref of Object.keys(get().byRef)) {
      if (isUnder(ref, path)) get().close(ref);
    }
  },
}));

// 标签关闭 → 删该 PDF 的桶。closer 只拿 ref（项目相对 path）= 桶 key。见 workspaceStore.registerTabCloser。
registerTabCloser('pdf', (ref) => usePdfStore.getState().close(ref));
