import { create } from 'zustand';
import type { FileNode } from '@shared/types';
import type { FsCreateResultEvent, FsListResultEvent, FsOpResultEvent, ServerEvent } from '@shared/protocol';
import { serializeCsv } from '@shared/csv';
import { wsClient } from '@/lib/ws';
import { useEditorStore } from '@/stores/editorStore';
import { useTableStore } from '@/stores/tableStore';
import { useHtmlAnnotStore } from '@/stores/htmlAnnotStore';
import { usePdfStore } from '@/stores/pdfStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import i18n from '@/lib/i18n';

/**
 * 文件树状态（懒加载 + watcher）：
 * - childrenByDir：已加载目录的直接子项，key 为项目相对路径（''=根）。折叠即从中删除该目录及后代。
 * - expanded：当前展开的目录（不含根，根恒在）。
 * - 展开 = loadDir(现读一层) + 订阅哨兵；折叠 = 丢弃子树 + 退订哨兵。
 * - 哨兵（或编辑器自存）发来 fs.changed → onFsChanged 只重读"已加载"的目录，不整树重建。
 * - 文件操作（改名/副本/移动/删除/定位）：发 RPC 给后端守门，成功后让打开态视图跟随/关闭（relocateViews/closeViews）。
 */

function sendWatch(projectId: string, path: string, on: boolean): void {
  void wsClient.request({ type: 'fs.watch', projectId, path, on }).catch(() => {});
}

// ── 行内新建（pendingNew）的纯函数辅助 ───────────────────────────────
export type NewKind = 'md' | 'csv' | 'folder';

/** 正在树内起名的那一行——独立瞬态，绝不进 childrenByDir（会被 loadDir 重读冲掉） */
export type PendingNew = { parentDir: string; kind: NewKind; name: string; error: string | null };

/** 正在行内重命名的那一行——和 pendingNew 是同一套手势的两端（提交走 fs.rename） */
export type PendingRename = { path: string; name: string; error: string | null };

// 落盘文件名兜底（类②写入内容）——不随界面语言翻译，固定中文
const DEFAULT_NAMES: Record<NewKind, string> = { md: '未命名', csv: '未命名表格', folder: '未命名文件夹' };
const EXT: Record<NewKind, string> = { md: '.md', csv: '.csv', folder: '' };

// 起步 CSV 骨架：3×3 空格子（含一行可改列名的表头），列数 ≥ 1。尺寸是参数不是结构（PRD 待定项）。
const CSV_SKELETON_COLS = 3;
const CSV_SKELETON_ROWS = 3;
function csvSkeleton(): string {
  const blankRow = (): string[] => Array.from({ length: CSV_SKELETON_COLS }, () => '');
  return serializeCsv({ headers: blankRow(), rows: Array.from({ length: CSV_SKELETON_ROWS }, blankRow) });
}

/** 路径分隔符等非法字符——macOS 上 / 与 : 都不能进文件名 */
function illegalName(name: string): boolean {
  return /[/:\\]/.test(name);
}

function posixDirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function posixBasename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** 选中项是不是目录——查它在父目录子项里的 isDirectory（FileNode 无 kind 字段） */
function isSelectedDir(selectedPath: string, childrenByDir: Map<string, FileNode[]>): boolean {
  const siblings = childrenByDir.get(posixDirname(selectedPath));
  return siblings?.find((n) => n.path === selectedPath)?.isDirectory ?? false;
}

/** 落点派生：选中目录→其内；选中文件→同级；无选中→项目根。 */
function deriveParentDir(selectedPath: string | null, childrenByDir: Map<string, FileNode[]>): string {
  if (selectedPath === null) return '';
  return isSelectedDir(selectedPath, childrenByDir) ? selectedPath : posixDirname(selectedPath);
}

function joinPath(parentDir: string, base: string, ext: string): string {
  const leaf = `${base}${ext}`;
  return parentDir ? `${parentDir}/${leaf}` : leaf;
}

/** 用户手输了 .md/.csv 则归一去重，避免拼成 foo.md.md */
function stripExt(name: string, ext: string): string {
  return ext && name.toLowerCase().endsWith(ext) ? name.slice(0, -ext.length) : name;
}

/**
 * 改名/移动前把所有打开编辑器 + 表格的 pending 落盘——否则主进程锁内读到的是 stale 磁盘版，
 * 回写会把用户最后的编辑一起丢掉（§十一 step 1）。多标签下所有打开的都要 flush（不只活跃那个）。
 */
async function flushOpenFiles(): Promise<void> {
  await Promise.all([useEditorStore.getState().flushAll(), useTableStore.getState().flushAll()]);
}

/**
 * 操作成功后让三个打开态视图跟随路径变更（改名/移动）。
 * newContent 仅在「.md 改名联动回写引用」时带，传给编辑器重置内存态、清 pending（§十一 C-1）。
 */
function relocateViews(oldRel: string, newRel: string, newContent?: string): void {
  useEditorStore.getState().relocate(oldRel, newRel, newContent);
  useTableStore.getState().relocate(oldRel, newRel);
  useHtmlAnnotStore.getState().relocate(oldRel, newRel);
  usePdfStore.getState().relocate(oldRel, newRel);
  useWorkspaceStore.getState().relocateTab(oldRel, newRel);
}

/** 删除后关闭指向被删路径（或其子树）的视图。 */
function closeViewsUnder(path: string): void {
  useEditorStore.getState().closeIfUnder(path);
  useTableStore.getState().closeIfUnder(path);
  useHtmlAnnotStore.getState().closeIfUnder(path);
  usePdfStore.getState().closeIfUnder(path);
  useWorkspaceStore.getState().closeTabsUnder(path);
}

/** 非 ok 结果的用户可读提示（撞名/越界/源没了）。 */
function opErrorMessage(status: FsOpResultEvent['status']): string {
  if (status === 'conflict') return i18n.t('files:fsError.conflict');
  if (status === 'invalid') return i18n.t('files:fsError.invalid');
  if (status === 'not-found') return i18n.t('files:fsError.notFound');
  if (status === 'incomplete') return i18n.t('files:fsError.incomplete');
  return i18n.t('files:fsError.failed');
}

// 一次提交在飞行中的标记——挡住 Enter→失焦的二次提交（详见 commitNew/commitRename 注释）
let committingNew = false;
let committingRename = false;

type FsState = {
  childrenByDir: Map<string, FileNode[]>;
  truncatedByDir: Map<string, number>;
  expanded: Set<string>;
  loadingDir: Set<string>;
  /** 最后点击的"焦点"路径（新建落点 / 键盘导航锚点 / 连选锚点都用它） */
  selectedPath: string | null;
  /** 多选集（含 selectedPath）。单选时 size===1；所有批量动作作用于它 */
  selectedPaths: Set<string>;
  currentProjectId: string | null;
  pendingNew: PendingNew | null;
  pendingRename: PendingRename | null;
  /** 正在进行中的大操作（副本/移动大文件夹）——行渲染转圈置灰、拦重复点 */
  busyPaths: Set<string>;

  init: (projectId: string) => Promise<void>;
  loadDir: (projectId: string, path: string) => Promise<void>;
  toggle: (projectId: string, path: string) => void;
  refresh: (projectId: string) => void;
  /** 单选（replace）：清空选区只选它，并设为焦点/锚点 */
  setSelected: (path: string | null) => void;
  /** Cmd 点：切换单个；空了则焦点退到剩余任一 */
  toggleSelected: (path: string) => void;
  /** Shift 连选：FileTree 算好 anchor→click 的可见区间路径传入 */
  setSelectedRange: (paths: string[]) => void;
  onFsChanged: (projectId: string, path: string | undefined) => void;
  beginNew: (kind: NewKind) => void;
  /** 右键文件夹/空白处「在此新建」：显式落点（folder 路径或 '' 根） */
  beginNewIn: (kind: NewKind, parentDir: string) => void;
  updateNewName: (name: string) => void;
  commitNew: () => Promise<string | null>;
  cancelNew: () => void;
  // ── 行内重命名 ──
  beginRename: (path: string, currentName: string) => void;
  updateRenameName: (name: string) => void;
  commitRename: () => Promise<void>;
  cancelRename: () => void;
  // ── 文件操作（发 RPC + 打开态联动）──
  duplicate: (path: string) => Promise<void>;
  moveEntries: (paths: string[], destDir: string) => Promise<void>;
  trashEntries: (paths: string[]) => Promise<void>;
  reveal: (path: string) => Promise<void>;
  reset: () => void;
};

const EMPTY = {
  childrenByDir: new Map<string, FileNode[]>(),
  truncatedByDir: new Map<string, number>(),
  expanded: new Set<string>(),
  loadingDir: new Set<string>(),
  selectedPath: null,
  selectedPaths: new Set<string>(),
  pendingNew: null,
  pendingRename: null,
  busyPaths: new Set<string>(),
};

export const useFsStore = create<FsState>((set, get) => ({
  ...EMPTY,
  currentProjectId: null,

  async init(projectId) {
    set({ ...EMPTY, currentProjectId: projectId });
    await get().loadDir(projectId, '');
    if (get().currentProjectId === projectId) sendWatch(projectId, '', true);
  },

  async loadDir(projectId, path) {
    set((s) => ({ loadingDir: new Set(s.loadingDir).add(path) }));
    try {
      const res = await wsClient.request<FsListResultEvent>({ type: 'fs.list', projectId, path });
      const st = get();
      const stale = st.currentProjectId !== projectId || (path !== '' && !st.expanded.has(path));
      if (stale) {
        set((s) => {
          const loadingDir = new Set(s.loadingDir);
          loadingDir.delete(path);
          return { loadingDir };
        });
        return;
      }
      if (res.type === 'fs.list.result') {
        set((s) => {
          const childrenByDir = new Map(s.childrenByDir).set(path, res.entries);
          const truncatedByDir = new Map(s.truncatedByDir);
          if (res.truncated) truncatedByDir.set(path, res.truncated);
          else truncatedByDir.delete(path);
          const loadingDir = new Set(s.loadingDir);
          loadingDir.delete(path);
          return { childrenByDir, truncatedByDir, loadingDir };
        });
        return;
      }
    } catch {
      // 落到下方清 loading
    }
    set((s) => {
      const loadingDir = new Set(s.loadingDir);
      loadingDir.delete(path);
      return { loadingDir };
    });
  },

  toggle(projectId, path) {
    if (get().expanded.has(path)) {
      const pref = `${path}/`;
      const keep = (k: string): boolean => k !== path && !k.startsWith(pref);
      set((s) => ({
        expanded: new Set([...s.expanded].filter(keep)),
        childrenByDir: new Map([...s.childrenByDir].filter(([k]) => keep(k))),
        truncatedByDir: new Map([...s.truncatedByDir].filter(([k]) => keep(k))),
      }));
      sendWatch(projectId, path, false);
    } else {
      set((s) => ({ expanded: new Set(s.expanded).add(path) }));
      void get().loadDir(projectId, path);
      sendWatch(projectId, path, true);
    }
  },

  refresh(projectId) {
    if (get().currentProjectId !== projectId) return;
    void get().loadDir(projectId, '');
    for (const dir of [...get().expanded]) void get().loadDir(projectId, dir);
  },

  setSelected(path) {
    if (path === null) set({ selectedPath: null, selectedPaths: new Set() });
    else set({ selectedPath: path, selectedPaths: new Set([path]) });
  },

  toggleSelected(path) {
    set((s) => {
      const next = new Set(s.selectedPaths);
      const adding = !next.has(path);
      if (adding) next.add(path);
      else next.delete(path);
      // 加入 → 焦点落在它；移除 → 只在移掉的正是当前焦点时才退到剩余末尾，否则焦点不动（保住连选锚点）
      let selectedPath = s.selectedPath;
      if (adding) selectedPath = path;
      else if (s.selectedPath === path) selectedPath = next.size ? [...next][next.size - 1] : null;
      return { selectedPaths: next, selectedPath };
    });
  },

  setSelectedRange(paths) {
    if (paths.length === 0) return;
    set({ selectedPaths: new Set(paths), selectedPath: paths[paths.length - 1] });
  },

  onFsChanged(projectId, path) {
    const { currentProjectId, childrenByDir } = get();
    if (!currentProjectId || projectId !== currentProjectId) return;
    if (typeof path === 'string') {
      if (childrenByDir.has(path)) void get().loadDir(currentProjectId, path);
    } else {
      for (const dir of [...childrenByDir.keys()]) void get().loadDir(currentProjectId, dir);
    }
  },

  beginNew(kind) {
    const { selectedPath, childrenByDir } = get();
    get().beginNewIn(kind, deriveParentDir(selectedPath, childrenByDir));
  },

  beginNewIn(kind, parentDir) {
    const { currentProjectId } = get();
    if (parentDir !== '' && currentProjectId && !get().expanded.has(parentDir)) {
      get().toggle(currentProjectId, parentDir);
    }
    set({ pendingNew: { parentDir, kind, name: '', error: null }, pendingRename: null });
  },

  updateNewName(name) {
    const p = get().pendingNew;
    if (!p) return;
    set({ pendingNew: { ...p, name, error: illegalName(name) ? i18n.t('files:fsError.illegalChars') : null } });
  },

  async commitNew() {
    if (committingNew) return null;
    const p = get().pendingNew;
    const projectId = get().currentProjectId;
    if (!p || !projectId) return null;

    const raw = p.name.trim();
    if (raw && illegalName(raw)) {
      set({ pendingNew: { ...p, error: i18n.t('files:fsError.illegalChars') } });
      return null;
    }

    const { kind, parentDir } = p;
    const ext = EXT[kind];
    const content = kind === 'csv' ? csvSkeleton() : '';

    const create = (path: string): Promise<FsCreateResultEvent['status']> =>
      wsClient
        .request<FsCreateResultEvent>(
          kind === 'folder'
            ? { type: 'fs.mkdir', projectId, path }
            : { type: 'fs.createFile', projectId, path, content },
        )
        .then((r) => r.status);

    committingNew = true;
    try {
      if (raw === '') {
        const defaultBase = DEFAULT_NAMES[kind];
        for (let n = 1; n <= 1000; n++) {
          const path = joinPath(parentDir, n === 1 ? defaultBase : `${defaultBase} ${n}`, ext);
          const status = await create(path);
          if (status === 'ok') return finishOpen(get, projectId, p, parentDir, path, kind);
          if (status !== 'conflict') return setError(get, p, i18n.t('files:fsError.createFailed'));
        }
        return setError(get, p, i18n.t('files:fsError.createFailed'));
      }

      const path = joinPath(parentDir, stripExt(raw, ext), ext);
      const status = await create(path);
      if (status === 'ok') return finishOpen(get, projectId, p, parentDir, path, kind);
      if (status === 'conflict') return setError(get, p, i18n.t('files:fsError.exists'));
      return setError(get, p, i18n.t('files:fsError.illegalName'));
    } finally {
      committingNew = false;
    }
  },

  cancelNew() {
    set({ pendingNew: null });
  },

  beginRename(path, currentName) {
    set({ pendingRename: { path, name: currentName, error: null }, pendingNew: null });
  },

  updateRenameName(name) {
    const p = get().pendingRename;
    if (!p) return;
    set({ pendingRename: { ...p, name, error: illegalName(name) ? i18n.t('files:fsError.illegalChars') : null } });
  },

  async commitRename() {
    if (committingRename) return;
    const p = get().pendingRename;
    const projectId = get().currentProjectId;
    if (!p || !projectId) return;

    const raw = p.name.trim();
    if (raw === '' || illegalName(raw)) {
      set({ pendingRename: { ...p, error: i18n.t('files:fsError.emptyOrIllegal') } });
      return;
    }
    if (raw === posixBasename(p.path)) {
      set({ pendingRename: null }); // 没改名，直接收工
      return;
    }

    committingRename = true;
    try {
      await flushOpenFiles(); // 改名前落盘所有打开编辑器 + 表格的 pending（见 flushOpenFiles 注释）
      const r = await wsClient.request<FsOpResultEvent>({ type: 'fs.rename', projectId, path: p.path, newName: raw });
      // await 后重检：起名期间用户可能 Esc / 切项目
      if (get().pendingRename !== p || get().currentProjectId !== projectId) return;
      if (r.status === 'ok') {
        // r.content 在 .md+assets 改名时带回写后的新内容，relocate 据此重置编辑器内存态（C-1）
        relocateViews(p.path, r.path, r.content);
        set({ pendingRename: null, selectedPath: r.path, selectedPaths: new Set([r.path]) });
      } else if (r.status === 'incomplete') {
        set({ pendingRename: null });
        alert(opErrorMessage(r.status));
      } else if (r.status === 'conflict') {
        set({ pendingRename: { ...p, error: i18n.t('files:fsError.exists') } });
      } else {
        set({ pendingRename: { ...p, error: i18n.t('files:fsError.illegalName') } });
      }
    } finally {
      committingRename = false;
    }
  },

  cancelRename() {
    set({ pendingRename: null });
  },

  async duplicate(path) {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    setBusy(path, true);
    try {
      const r = await wsClient.request<FsOpResultEvent>({ type: 'fs.duplicate', projectId, path });
      if (r.status !== 'ok') alert(opErrorMessage(r.status));
    } finally {
      setBusy(path, false);
    }
  },

  async moveEntries(paths, destDir) {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    await flushOpenFiles(); // 移动前落盘所有打开编辑器 + 表格的 pending（同改名，避免 relocate 后 stale autosave）
    for (const path of paths) {
      setBusy(path, true);
      try {
        const r = await wsClient.request<FsOpResultEvent>({ type: 'fs.move', projectId, path, destDir });
        if (r.status === 'ok') relocateViews(path, r.path);
        else if (r.status === 'conflict' || r.status === 'invalid' || r.status === 'incomplete')
          alert(opErrorMessage(r.status));
      } finally {
        setBusy(path, false);
      }
    }
  },

  async trashEntries(paths) {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    for (const path of paths) {
      setBusy(path, true);
      try {
        const r = await wsClient.request<FsOpResultEvent>({ type: 'fs.trash', projectId, path });
        if (get().currentProjectId !== projectId) return; // await 后重检：切项目则停手，别误关新项目视图
        if (r.status === 'ok') closeViewsUnder(path);
      } finally {
        setBusy(path, false);
      }
    }
    // 选区里被删的清掉
    set((s) => {
      const selectedPaths = new Set([...s.selectedPaths].filter((p) => !paths.includes(p)));
      const selectedPath = s.selectedPath && paths.includes(s.selectedPath) ? null : s.selectedPath;
      return { selectedPaths, selectedPath };
    });
  },

  async reveal(path) {
    const projectId = get().currentProjectId;
    if (!projectId) return;
    await wsClient.request({ type: 'fs.reveal', projectId, path }).catch(() => {});
  },

  reset() {
    const pid = get().currentProjectId;
    if (pid) sendWatch(pid, '', false);
    set({ ...EMPTY, currentProjectId: null });
  },
}));

function setBusy(path: string, on: boolean): void {
  useFsStore.setState((s) => {
    const busyPaths = new Set(s.busyPaths);
    if (on) busyPaths.add(path);
    else busyPaths.delete(path);
    return { busyPaths };
  });
}

type GetFs = () => FsState;

function setError(get: GetFs, started: PendingNew, error: string): null {
  const cur = get().pendingNew;
  if (cur === started) useFsStore.setState({ pendingNew: { ...cur, error } });
  return null;
}

function finishOpen(
  get: GetFs,
  projectId: string,
  started: PendingNew,
  parentDir: string,
  path: string,
  kind: NewKind,
): string | null {
  const st = get();
  if (st.currentProjectId !== projectId || st.pendingNew !== started) return null;

  st.cancelNew();
  if (parentDir === '' || st.expanded.has(parentDir)) void st.loadDir(projectId, parentDir);
  else st.toggle(projectId, parentDir);

  st.setSelected(path);
  if (kind === 'folder') {
    st.toggle(projectId, path);
    return null;
  }
  return path;
}

let unsubscribe: (() => void) | null = null;
export function bindFsAutoRefresh(): void {
  if (unsubscribe) return;
  unsubscribe = wsClient.subscribe((ev: ServerEvent) => {
    if (ev.type === 'fs.changed') {
      useFsStore.getState().onFsChanged(ev.projectId, ev.path);
    }
  });
}
