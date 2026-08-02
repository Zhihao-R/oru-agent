/**
 * 布局状态：左/右栏宽度、左栏自动隐藏 / 手动收起
 * - localStorage 持久化（renderer 端 UI 偏好，不入后端 settings）
 * - 拖拽期间只改内存（setSidebarWidth/setEditorWidth），松手时调 persistLayout 写盘
 *   —— 避免每次 mousemove 都做磁盘 I/O 引起的卡顿
 */
import { create } from 'zustand';

const STORAGE_KEY = 'oru.layout';

export const SIDEBAR_BOUNDS = { min: 200, max: 480, default: 260 };
export const EDITOR_BOUNDS = { min: 320, default: 400 };
/** 右栏（编辑器 / HTML 预览 / 表格共用）拖到最宽时，给对话区保留的最小可用宽度 */
export const MIN_CHAT_WIDTH = 380;
// deck 4 列布局：chat / annot 两栏可拖；preview 占剩余
export const DECK_CHAT_BOUNDS = { min: 280, max: 600, default: 400 };
export const DECK_ANNOT_BOUNDS = { min: 240, max: 480, default: 320 };

export type SidebarView = 'chat' | 'project';

type Persisted = {
  sidebarWidth: number;
  editorWidth: number;
  autoHideSidebar: boolean;
  sidebarCollapsed: boolean;
  annotPaneCollapsed: boolean;
  deckChatWidth: number;
  deckAnnotWidth: number;
};

/**
 * sidebarView 不持久化：是会话级语义状态，不是用户偏好。
 * 每次启动默认「对话」，避免"上次手滑切到项目"导致下次启动看到一堆文件。
 */
type LayoutState = Persisted & {
  sidebarView: SidebarView;
  /** 会话搜索是否展开——上提到 layout（不持久化），供侧栏 tab 行的搜索图标与会话列表的搜索栏共享 */
  convSearchOpen: boolean;
  setConvSearchOpen: (b: boolean) => void;
  /** 拖拽期间高频更新：只改内存 */
  setSidebarWidth: (n: number) => void;
  /** extraReserve：editor 之外右侧固定列宽（html 预览态的批注栏），夹宽时一并预留给对话区 */
  setEditorWidth: (n: number, extraReserve?: number) => void;
  setDeckChatWidth: (n: number) => void;
  setDeckAnnotWidth: (n: number) => void;
  /** 拖拽结束时把当前快照写盘 */
  persistLayout: () => void;
  setAutoHideSidebar: (b: boolean) => void;
  toggleSidebarCollapsed: () => void;
  toggleAnnotPaneCollapsed: () => void;
  setSidebarView: (v: SidebarView) => void;
};

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 右栏能拖到的最大宽度 = 视口 − 占位侧栏 − 对话区最小宽度 − 右侧其它固定列。
 * 不写死 800——那是个魔数，在宽屏上恰好≈一半，于是「只能拖到中间」。约束的根本是
 * 「对话区还能用」，所以上限随视口与侧栏算出来，而非拍一个固定值。
 * 侧栏仅在常驻展开（非 autoHide / 非 collapsed）时占布局空间，autoHide 是浮层不占位。
 * extraReserve：editor 之外右侧还占着的固定列宽——html 预览态的批注栏（deckAnnotWidth，可收起）。
 * 不算进来，editor 拖宽时只给对话区留 MIN，批注栏那一列就把对话区挤没了。
 */
function editorMaxWidth(
  sidebar: number,
  autoHide: boolean,
  collapsed: boolean,
  extraReserve = 0,
): number {
  const vw = typeof window === 'undefined' ? Infinity : window.innerWidth;
  const occupied = autoHide || collapsed ? 0 : sidebar;
  return Math.max(EDITOR_BOUNDS.min, vw - occupied - MIN_CHAT_WIDTH - extraReserve);
}

function load(): Persisted {
  const fallback: Persisted = {
    sidebarWidth: SIDEBAR_BOUNDS.default,
    editorWidth: EDITOR_BOUNDS.default,
    autoHideSidebar: false,
    sidebarCollapsed: false,
    annotPaneCollapsed: false,
    deckChatWidth: DECK_CHAT_BOUNDS.default,
    deckAnnotWidth: DECK_ANNOT_BOUNDS.default,
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const obj = JSON.parse(raw) as Partial<Persisted>;
    return {
      sidebarWidth: clamp(
        obj.sidebarWidth ?? fallback.sidebarWidth,
        SIDEBAR_BOUNDS.min,
        SIDEBAR_BOUNDS.max,
      ),
      editorWidth: clamp(
        obj.editorWidth ?? fallback.editorWidth,
        EDITOR_BOUNDS.min,
        editorMaxWidth(
          obj.sidebarWidth ?? fallback.sidebarWidth,
          !!obj.autoHideSidebar,
          !!obj.sidebarCollapsed,
        ),
      ),
      autoHideSidebar: !!obj.autoHideSidebar,
      sidebarCollapsed: !!obj.sidebarCollapsed,
      annotPaneCollapsed: !!obj.annotPaneCollapsed,
      deckChatWidth: clamp(
        obj.deckChatWidth ?? fallback.deckChatWidth,
        DECK_CHAT_BOUNDS.min,
        DECK_CHAT_BOUNDS.max,
      ),
      deckAnnotWidth: clamp(
        obj.deckAnnotWidth ?? fallback.deckAnnotWidth,
        DECK_ANNOT_BOUNDS.min,
        DECK_ANNOT_BOUNDS.max,
      ),
    };
  } catch {
    return fallback;
  }
}

function save(s: Persisted): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // 忽略 quota / 隐身模式
  }
}

function snapshot(get: () => LayoutState): Persisted {
  const { sidebarWidth, editorWidth, autoHideSidebar, sidebarCollapsed, annotPaneCollapsed, deckChatWidth, deckAnnotWidth } = get();
  return { sidebarWidth, editorWidth, autoHideSidebar, sidebarCollapsed, annotPaneCollapsed, deckChatWidth, deckAnnotWidth };
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  ...load(),
  sidebarView: 'chat',
  convSearchOpen: false,
  setConvSearchOpen(b) {
    if (b === get().convSearchOpen) return;
    set({ convSearchOpen: b });
  },
  setSidebarWidth(n) {
    const v = clamp(n, SIDEBAR_BOUNDS.min, SIDEBAR_BOUNDS.max);
    if (v === get().sidebarWidth) return;
    set({ sidebarWidth: v });
  },
  setEditorWidth(n, extraReserve = 0) {
    const { sidebarWidth, autoHideSidebar, sidebarCollapsed } = get();
    const max = editorMaxWidth(sidebarWidth, autoHideSidebar, sidebarCollapsed, extraReserve);
    const v = clamp(n, EDITOR_BOUNDS.min, max);
    if (v === get().editorWidth) return;
    set({ editorWidth: v });
  },
  setDeckChatWidth(n) {
    const v = clamp(n, DECK_CHAT_BOUNDS.min, DECK_CHAT_BOUNDS.max);
    if (v === get().deckChatWidth) return;
    set({ deckChatWidth: v });
  },
  setDeckAnnotWidth(n) {
    const v = clamp(n, DECK_ANNOT_BOUNDS.min, DECK_ANNOT_BOUNDS.max);
    if (v === get().deckAnnotWidth) return;
    set({ deckAnnotWidth: v });
  },
  persistLayout() {
    save(snapshot(get));
  },
  setAutoHideSidebar(b) {
    if (b === get().autoHideSidebar) return;
    set({ autoHideSidebar: b });
    save(snapshot(get));
  },
  toggleSidebarCollapsed() {
    set({ sidebarCollapsed: !get().sidebarCollapsed });
    save(snapshot(get));
  },
  toggleAnnotPaneCollapsed() {
    set({ annotPaneCollapsed: !get().annotPaneCollapsed });
    save(snapshot(get));
  },
  setSidebarView(v) {
    if (v === get().sidebarView) return;
    // 离开对话视图时收起搜索——否则切回来会弹出个空搜索框并抢焦点（review 修复）
    set({ sidebarView: v, ...(v !== 'chat' ? { convSearchOpen: false } : {}) });
  },
}));
