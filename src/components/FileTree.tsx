import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Table2,
} from 'lucide-react';
import type { FileNode } from '@shared/types';
import { cn } from '@/lib/cn';
import { basename } from '@/lib/paths';
import { setFileDragData, readFileDragPayload } from '@/lib/fileDrag';
import { fileKind, type FileKind } from '@/lib/fileKind';
import { useWorkspaceStore, makeTab } from '@/stores/workspaceStore';
import { useFsStore, bindFsAutoRefresh, type NewKind, type PendingNew, type PendingRename } from '@/stores/fsStore';
import { NewFileMenu } from './NewFileMenu';
import { openProjectFile } from '@/lib/openProjectFile';
import { useProjectStore } from '@/stores/projectStore';
import { usePdfStore } from '@/stores/pdfStore';
import { useArtifactStore } from '@/stores/artifactStore';
import { referenceFilesToComposer } from '@/lib/referenceFiles';
import { FileTreeContextMenu, type ContextMenuState } from './FileTreeContextMenu';

type FlatRow =
  | { kind: 'node'; key: string; node: FileNode; depth: number }
  | { kind: 'empty'; key: string; depth: number }
  | { kind: 'more'; key: string; depth: number; count: number }
  | { kind: 'new'; key: string; depth: number };

/**
 * 把"已加载目录映射 + 展开集"摊平成行。从根（key=''）起，只下钻到已展开的目录。
 * 后端已按"目录在前、同类按名"排好序，这里不再排。空目录给一行占位，截断给一行"还有 N 项"。
 * 起名中的新行（pendingNew）注入到其落点目录的子项顶部，不来自任何 FileNode。
 */
function flatten(
  childrenByDir: Map<string, FileNode[]>,
  expanded: Set<string>,
  truncatedByDir: Map<string, number>,
  pendingNew: PendingNew | null,
): FlatRow[] {
  const rows: FlatRow[] = [];
  function walk(dirPath: string, depth: number): void {
    const children = childrenByDir.get(dirPath);
    if (children === undefined) return; // 尚未加载
    const hasNew = pendingNew?.parentDir === dirPath;
    if (hasNew) rows.push({ kind: 'new', key: `${dirPath} new`, depth });
    if (children.length === 0 && !hasNew) {
      rows.push({ kind: 'empty', key: `${dirPath} empty`, depth });
    }
    for (const node of children) {
      rows.push({ kind: 'node', key: node.path, node, depth });
      if (node.isDirectory && expanded.has(node.path)) walk(node.path, depth + 1);
    }
    const truncated = truncatedByDir.get(dirPath);
    if (truncated) rows.push({ kind: 'more', key: `${dirPath} more`, depth, count: truncated });
  }
  walk('', 0);
  return rows;
}

type FileTreeProps = {
  projectId: string | null;
};

export function FileTree({ projectId }: FileTreeProps): JSX.Element {
  const { t } = useTranslation('files');
  const childrenByDir = useFsStore((s) => s.childrenByDir);
  const truncatedByDir = useFsStore((s) => s.truncatedByDir);
  const expanded = useFsStore((s) => s.expanded);
  const loadingDir = useFsStore((s) => s.loadingDir);
  const selectedPath = useFsStore((s) => s.selectedPath);
  const selectedPaths = useFsStore((s) => s.selectedPaths);
  const busyPaths = useFsStore((s) => s.busyPaths);
  const init = useFsStore((s) => s.init);
  const reset = useFsStore((s) => s.reset);
  const toggleDir = useFsStore((s) => s.toggle);
  const refresh = useFsStore((s) => s.refresh);
  const setSelected = useFsStore((s) => s.setSelected);
  const toggleSelected = useFsStore((s) => s.toggleSelected);
  const setSelectedRange = useFsStore((s) => s.setSelectedRange);
  const pendingNew = useFsStore((s) => s.pendingNew);
  const beginNew = useFsStore((s) => s.beginNew);
  const updateNewName = useFsStore((s) => s.updateNewName);
  const commitNew = useFsStore((s) => s.commitNew);
  const cancelNew = useFsStore((s) => s.cancelNew);
  const pendingRename = useFsStore((s) => s.pendingRename);
  const updateRenameName = useFsStore((s) => s.updateRenameName);
  const commitRename = useFsStore((s) => s.commitRename);
  const cancelRename = useFsStore((s) => s.cancelRename);

  const openTab = useWorkspaceStore((s) => s.openTab);
  const adoptDeck = useArtifactStore((s) => s.adoptDeck);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [newMenu, setNewMenu] = useState<DOMRect | null>(null);

  useEffect(() => {
    bindFsAutoRefresh();
  }, []);

  // 上一次的 projectId——区分「项目真正切换」与「组件重挂载」（侧栏在非对话页会卸载，
  // 切到主页再回对话会让 FileTree 重挂载）。重挂载时 ref 重新为 undefined，不触发清场。
  const prevProjectIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (projectId) void init(projectId);
    else reset();
    setSelected(null);
    // 仅在「项目真正切换」时收掉上个项目残留的标签工作区（md/csv/image/html，含 flush + 经 closer 销桶）。
    // 不在每次挂载/跨页返回时清——否则切主页再回对话会丢全部标签（违反 PRD §6/§7 跨页现场不变）。
    // 项目切换器在侧栏内、切换时 FileTree 挂载着，ref 在生命周期内能捕获真实切换。
    if (prevProjectIdRef.current !== undefined && prevProjectIdRef.current !== projectId) {
      useWorkspaceStore.getState().reset();
    }
    prevProjectIdRef.current = projectId;
    setMenu(null);
    setNewMenu(null);
  }, [projectId, init, reset, setSelected]);

  const rows = useMemo(
    () => flatten(childrenByDir, expanded, truncatedByDir, pendingNew),
    [childrenByDir, expanded, truncatedByDir, pendingNew],
  );

  // 键盘导航只在文件/目录行之间移动，跳过占位行
  const nodeRows = useMemo(() => rows.filter((r): r is Extract<FlatRow, { kind: 'node' }> => r.kind === 'node'), [rows]);
  const selectedNodeIndex = useMemo(() => {
    if (!selectedPath) return -1;
    return nodeRows.findIndex((r) => r.node.path === selectedPath);
  }, [nodeRows, selectedPath]);

  const rootLoaded = childrenByDir.has('');
  const rootLoading = loadingDir.has('');

  /**
   * 右键「加入演示稿」：把目标收编为 deck，再 activate 进演示稿。
   * - 文件夹 → 收编它自身
   * - html 文件 → 收编它所在的文件夹（deck 物理上是文件夹，html 是用户顺手抓到的入口把手）
   * adopt 读盘校验翻不翻得出页，幂等（已登记返回原 id）。不是 deck → 后端给可读原因；异常 → 兜底提示。
   */
  async function adoptAsDeck(node: FileNode): Promise<void> {
    if (!projectId) return;
    // html 落到父文件夹：POSIX 相对路径去掉末段文件名
    const folderPath = node.isDirectory ? node.path : node.path.split('/').slice(0, -1).join('/');
    // 项目根直属的 html 没有可作演示稿的所在文件夹——与文件夹收编只认子文件夹一致，不把整个项目根当 deck
    if (folderPath === '') {
      alert(t('adoptRootHtmlError'));
      return;
    }
    try {
      const res = await adoptDeck(projectId, folderPath);
      // 成功 → 开成 deck 标签（deck 是右栏标签的平级一员，§3.2）。title 用文件夹名（= deck 名）；
      // artifact.list 广播随后到达，DeckTabBody 据 artifactId 拿到完整 record。
      if (res.ok) openTab(makeTab({ kind: 'deck', projectId, ref: res.artifactId, title: basename(folderPath) }));
      else alert(res.message);
    } catch {
      alert(t('adoptFailed'));
    }
  }

  /** 把若干文件作为 file 引用加进当前对话（§3）——文件夹也允许引用。共享实现见 lib/referenceFiles。 */
  function referenceFiles(paths: string[]): void {
    referenceFilesToComposer(paths);
  }

  /** 右键「移到回收站」：先确认（单个带名 / 文件夹补含内容提示；多个给计数）再删 */
  function trashWithConfirm(paths: string[]): void {
    if (paths.length === 0) return;
    let message: string;
    if (paths.length === 1) {
      const path = paths[0];
      const name = path.split('/').pop() ?? path;
      const isDir = nodeRows.some((r) => r.node.path === path && r.node.isDirectory);
      message = isDir ? t('trashDirConfirm', { name }) : t('trashConfirm', { name });
    } else {
      message = t('trashMultiConfirm', { count: paths.length });
    }
    if (window.confirm(message)) void useFsStore.getState().trashEntries(paths);
  }

  /** 右键命中某节点：若它已在选区内，批量动作作用于整个选区；否则先单选它 */
  function openContextMenu(node: FileNode, x: number, y: number): void {
    const selected = useFsStore.getState().selectedPaths;
    if (selected.has(node.path)) {
      setMenu({ node, x, y, targets: [...selected] });
    } else {
      setSelected(node.path);
      setMenu({ node, x, y, targets: [node.path] });
    }
  }

  /** 点击行：按修饰键决定单选 / 切换 / 连选；连选区间在可见 nodeRows 顺序里取 anchor→click */
  function onRowSelect(node: FileNode, e: MouseEvent): void {
    if (e.metaKey || e.ctrlKey) {
      toggleSelected(node.path);
    } else if (e.shiftKey && selectedPath) {
      const anchor = nodeRows.findIndex((r) => r.node.path === selectedPath);
      const click = nodeRows.findIndex((r) => r.node.path === node.path);
      if (anchor === -1 || click === -1) {
        setSelected(node.path);
        return;
      }
      const [lo, hi] = anchor <= click ? [anchor, click] : [click, anchor];
      setSelectedRange(nodeRows.slice(lo, hi + 1).map((r) => r.node.path));
    } else {
      setSelected(node.path);
    }
  }

  /** 提交起名：建出文件后，把待打开路径交给 activate 统一开（右栏互斥只此一处）。文件夹返回 null，已在 store 内展开 */
  async function openAfterCommit(): Promise<void> {
    const path = await commitNew();
    if (!path) return;
    activate({ name: path.split('/').pop() ?? path, path, isDirectory: false });
  }

  /**
   * 按 fileKind 路由打开（§4）——双击行 / Enter 触发；chevron 单独走 toggleDir。
   * md / csv / image / html / deck 全是右栏标签工作区里的平级一员（可多开、可共存，§3.2 §3.9）。
   * 开文件标签不再退 deck——deck 是同列的另一个标签，切谁谁活跃。
   * 四类可开文件走 openProjectFile 统一通路（对话组件的打开入口同源）。
   */
  function activate(node: FileNode): void {
    if (!projectId) return;
    const kind = fileKind(node);
    switch (kind) {
      case 'folder':
        toggleDir(projectId, node.path); // deck 文件夹不自动辨别——进演示稿走右键「加入演示稿」
        return;
      case 'markdown':
      case 'csv':
      case 'html':
      case 'image':
        openProjectFile(projectId, node.path);
        return;
      case 'xlsx':
        // 点击 xlsx = 开只读预览标签（内存转换零落盘）；转可编辑 CSV 是预览里的显式动作
        openTab(makeTab({ kind: 'xlsx', projectId, ref: node.path, title: basename(node.path) }));
        return;
      case 'pdf': {
        const root = useProjectStore.getState().projects.find((p) => p.id === projectId)?.path;
        if (!root) return;
        openTab(makeTab({ kind: 'pdf', projectId, ref: node.path, title: basename(node.path) }));
        // 建该 PDF 的视图态桶（已开则保留现场）。WS 无联动，桶纯前端——见 pdfStore。
        usePdfStore.getState().open(node.path, `${root}/${node.path}`);
        return;
      }
      case 'other':
        return; // 维持现状，不强行处理
    }
  }

  function moveSelection(delta: number): void {
    if (nodeRows.length === 0) return;
    let next = selectedNodeIndex + delta;
    if (next < 0) next = 0;
    if (next > nodeRows.length - 1) next = nodeRows.length - 1;
    setSelected(nodeRows[next].node.path);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (nodeRows.length === 0 || !projectId) return;
    const current = selectedNodeIndex >= 0 ? nodeRows[selectedNodeIndex] : undefined;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'ArrowRight') {
      if (current && current.node.isDirectory && !expanded.has(current.node.path)) {
        e.preventDefault();
        toggleDir(projectId, current.node.path);
      }
    } else if (e.key === 'ArrowLeft') {
      if (current && current.node.isDirectory && expanded.has(current.node.path)) {
        e.preventDefault();
        toggleDir(projectId, current.node.path);
      }
    } else if (e.key === 'Enter') {
      if (current) {
        e.preventDefault();
        activate(current.node);
      }
    }
  }

  return (
    // data-aside-region：随手评点的场所锚点（契约清单见 shared/asideRegions.ts）
    <div data-aside-region="file-tree" className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
          {t('heading')}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="rounded p-1 text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary disabled:opacity-40"
            onClick={(e) => setNewMenu(e.currentTarget.getBoundingClientRect())}
            disabled={!projectId || !rootLoaded}
            title={t('newTitle')}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary disabled:opacity-40"
            onClick={() => projectId && refresh(projectId)}
            disabled={!projectId || rootLoading}
            title={t('refreshTitle')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', rootLoading && 'animate-spin')} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        // 点空白处取消选中 → 新建落回项目根（VS Code 同款逃生口；否则选中会一直黏在文件夹上）
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(null);
        }}
        // 右键空白处（命中容器本身，非某一行）→ 弹空白菜单，落点项目根；行的右键已 stopPropagation
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setMenu({ node: null, x: e.clientX, y: e.clientY, targets: [] });
          }
        }}
        className="flex-1 overflow-y-auto px-1 pb-3 outline-none [scrollbar-gutter:stable]"
      >
        {!projectId && <EmptyHint text={t('noProject')} />}
        {projectId && !rootLoaded && rootLoading && <EmptyHint text={t('loading')} />}
        {projectId && !rootLoaded && !rootLoading && <EmptyHint text={t('loadFailed')} />}

        {projectId &&
          rootLoaded &&
          rows.map((row) => {
            if (row.kind === 'empty') return <PlaceholderRow key={row.key} depth={row.depth} text={t('emptyFolder')} />;
            if (row.kind === 'more')
              return <PlaceholderRow key={row.key} depth={row.depth} text={t('moreItems', { count: row.count })} />;
            if (row.kind === 'new' && pendingNew)
              return (
                <NewFileInput
                  key={row.key}
                  pending={pendingNew}
                  depth={row.depth}
                  onChange={updateNewName}
                  onCommit={() => void openAfterCommit()}
                  onCancel={cancelNew}
                />
              );
            if (row.kind === 'new') return null;
            return (
              <FileTreeRow
                key={row.key}
                node={row.node}
                depth={row.depth}
                isSelected={selectedPaths.has(row.node.path)}
                isExpanded={expanded.has(row.node.path)}
                isLoading={loadingDir.has(row.node.path)}
                isBusy={busyPaths.has(row.node.path)}
                rename={pendingRename?.path === row.node.path ? pendingRename : null}
                onRenameChange={updateRenameName}
                onRenameCommit={() => void commitRename()}
                onRenameCancel={cancelRename}
                onSelect={(e) => onRowSelect(row.node, e)}
                onActivate={() => activate(row.node)}
                onToggle={() => projectId && toggleDir(projectId, row.node.path)}
                onContextMenu={(x, y) => openContextMenu(row.node, x, y)}
                onMoveInto={(paths) => void useFsStore.getState().moveEntries(paths, row.node.path)}
              />
            );
          })}
      </div>

      {menu && (
        <FileTreeContextMenu
          state={menu}
          onClose={() => setMenu(null)}
          onReference={referenceFiles}
          onAdoptDeck={(node) => void adoptAsDeck(node)}
          onRename={(node) => useFsStore.getState().beginRename(node.path, node.name)}
          onDuplicate={(paths) => paths.forEach((p) => void useFsStore.getState().duplicate(p))}
          onCopyPath={(node) => void navigator.clipboard.writeText(node.path)}
          onReveal={(node) => void useFsStore.getState().reveal(node.path)}
          onTrash={trashWithConfirm}
          onNewFile={(kind, parentDir) => useFsStore.getState().beginNewIn(kind, parentDir)}
        />
      )}

      {newMenu && (
        <NewFileMenu
          anchor={newMenu}
          onPick={(kind) => beginNew(kind)}
          onClose={() => setNewMenu(null)}
        />
      )}
    </div>
  );
}

function EmptyHint({ text }: { text: string }): JSX.Element {
  return <div className="px-3 py-6 text-center text-xs text-text-tertiary">{text}</div>;
}

function PlaceholderRow({ depth, text }: { depth: number; text: string }): JSX.Element {
  return (
    <div
      className="flex h-6 items-center text-xs italic text-text-tertiary"
      style={{ paddingLeft: `${depth * 12 + 24}px` }}
    >
      {text}
    </div>
  );
}

const NEW_KIND_TO_FILEKIND: Record<NewKind, FileKind> = { md: 'markdown', csv: 'csv', folder: 'folder' };
const NEW_SUFFIX: Record<NewKind, string> = { md: '.md', csv: '.csv', folder: '' };

/**
 * 行内起名：受控 input + 固定后缀提示（.md/.csv 跟在名字后，用户只打基础名）。不来自任何 FileNode。
 * 提交=回车 / 失焦（永远产出文件），取消=Esc（唯一反悔出口）。聚焦期间吞掉所有按键，
 * 屏蔽应用全局快捷键（保存 / 新建等）误触发。
 */
function NewFileInput({
  pending,
  depth,
  onChange,
  onCommit,
  onCancel,
}: {
  pending: PendingNew;
  depth: number;
  onChange: (name: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    e.stopPropagation(); // 聚焦期间不让 Cmd+S / Cmd+N 等全局快捷键漏到 window
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div style={{ paddingLeft: `${depth * 12 + 4}px` }} className="pr-2">
      <div className="flex h-6 items-center gap-1">
        <span aria-hidden="true" className="flex h-4 w-4 shrink-0" />
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary">
          <KindIcon kind={NEW_KIND_TO_FILEKIND[pending.kind]} isExpanded={false} />
        </span>
        <input
          ref={inputRef}
          value={pending.name}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onCommit}
          className="min-w-0 flex-1 rounded-sm border border-accent bg-canvas px-1 text-sm text-text-primary outline-none"
        />
        {NEW_SUFFIX[pending.kind] && (
          <span className="shrink-0 text-sm text-text-tertiary">{NEW_SUFFIX[pending.kind]}</span>
        )}
      </div>
      {pending.error && <div className="pl-9 text-xs text-warn">{pending.error}</div>}
    </div>
  );
}

/** 五类各给一个图标——集中映射，不在组件里散落 if（§3）。 */
function KindIcon({ kind, isExpanded }: { kind: FileKind; isExpanded: boolean }): JSX.Element {
  const cls = 'h-3.5 w-3.5';
  switch (kind) {
    case 'folder':
      return isExpanded ? <FolderOpen className={cls} strokeWidth={1.5} /> : <Folder className={cls} strokeWidth={1.5} />;
    case 'markdown':
      return <FileText className={cls} strokeWidth={1.5} />;
    case 'html':
      return <FileCode2 className={cls} strokeWidth={1.5} />;
    case 'image':
      return <FileImage className={cls} strokeWidth={1.5} />;
    case 'csv':
      return <Table2 className={cls} strokeWidth={1.5} />;
    case 'xlsx':
      return <FileSpreadsheet className={cls} strokeWidth={1.5} />;
    case 'pdf':
      return <FileType className={cls} strokeWidth={1.5} />;
    case 'other':
      return <File className={cn(cls, 'opacity-50')} strokeWidth={1.5} />;
  }
}

type FileTreeRowProps = {
  node: FileNode;
  depth: number;
  isSelected: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  isBusy: boolean;
  rename: PendingRename | null;
  onRenameChange: (name: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onSelect: (e: MouseEvent) => void;
  onActivate: () => void;
  onToggle: () => void;
  onContextMenu: (x: number, y: number) => void;
  /** 拖入此文件夹的落点处理（只有文件夹行接 drop）：把 payload.paths 移到本节点 */
  onMoveInto: (paths: string[]) => void;
};

function FileTreeRow({
  node,
  depth,
  isSelected,
  isExpanded,
  isLoading,
  isBusy,
  rename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onSelect,
  onActivate,
  onToggle,
  onContextMenu,
  onMoveInto,
}: FileTreeRowProps): JSX.Element {
  const kind = fileKind(node);
  const dimmed = kind === 'other';
  const [dropTarget, setDropTarget] = useState(false);

  function onDragStart(e: DragEvent<HTMLDivElement>): void {
    // 被拖节点在选区内 → 带整组选中路径（批量移动）；否则只带它，并先单选它
    const selected = useFsStore.getState().selectedPaths;
    let paths: string[];
    if (selected.has(node.path)) {
      paths = [...selected];
    } else {
      useFsStore.getState().setSelected(node.path);
      paths = [node.path];
    }
    setFileDragData(e, { paths, path: node.path, name: node.name });
    e.dataTransfer.effectAllowed = 'copyMove';
  }

  function readPaths(e: DragEvent<HTMLDivElement>): string[] | null {
    const payload = readFileDragPayload(e);
    return payload ? payload.paths : null;
  }

  // 只有文件夹接收 drop：非文件夹不 preventDefault → 浏览器回弹（视觉上拒收）
  function onDragOver(e: DragEvent<HTMLDivElement>): void {
    if (!node.isDirectory) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dropTarget) setDropTarget(true);
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    if (!node.isDirectory) return;
    e.preventDefault();
    setDropTarget(false);
    const paths = readPaths(e);
    if (!paths) return;
    // 落到自身 / 已在本目录直属（原地移动）→ 忽略；后端也会挡 invalid，前端先省一趟
    const parentOf = (p: string): string => {
      const i = p.lastIndexOf('/');
      return i === -1 ? '' : p.slice(0, i); // 根目录直属文件无 '/'，父目录是 ''
    };
    const valid = paths.filter((p) => p !== node.path && parentOf(p) !== node.path);
    if (valid.length === 0) return;
    onMoveInto(valid);
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => dropTarget && setDropTarget(false)}
      onDrop={onDrop}
      className={cn(
        'group flex h-6 cursor-default items-center gap-1 rounded-sm pr-2 text-sm transition-colors',
        isSelected ? 'bg-accent-soft text-text-primary' : 'hover:bg-hover',
        dropTarget && 'ring-1 ring-inset ring-accent',
        isBusy && 'opacity-60',
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      onClick={onSelect}
      onDoubleClick={onActivate}
      // 行右键不冒泡到容器（否则空白菜单也被触发）
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      {node.isDirectory ? (
        <button
          type="button"
          className="flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.5} />
          ) : isExpanded ? (
            <ChevronDown className="h-3 w-3" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="h-3 w-3" strokeWidth={1.5} />
          )}
        </button>
      ) : (
        // 文件无 chevron，但占同一格——必须用 flex + shrink-0 跟 button 结构一致，
        // 否则 inline-block 在窄行内被 flex 父级 shrink 一两像素，文件列就比文件夹列错位
        <span aria-hidden="true" className="flex h-4 w-4 shrink-0" />
      )}

      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary">
        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} /> : <KindIcon kind={kind} isExpanded={isExpanded} />}
      </span>

      {rename ? (
        <RenameInput rename={rename} onChange={onRenameChange} onCommit={onRenameCommit} onCancel={onRenameCancel} />
      ) : (
        <span
          className={cn(
            'truncate',
            dimmed ? 'text-text-tertiary' : 'text-text-secondary',
            isSelected && 'text-text-primary',
          )}
        >
          {node.name}
        </span>
      )}
    </div>
  );
}

/**
 * 重命名预选基名的终点：扩展名前最后一个点。无扩展名（`README`、文件夹）/ dotfile（`.gitignore`，dot===0）
 * → 返回全长、全选。`a.test.md` → 选到最后一个点前 `a.test`。
 */
export function baseNameEnd(name: string): number {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}

/**
 * 行内重命名：与 NewFileInput 同一套手势/样式（受控 input + Enter 提交 / Esc 取消 / 失焦提交）。
 * 聚焦后只预选基名、不选中扩展名——防一打字连 `.md` 一起替换掉；扩展名仍可手动编辑（改扩展名换类型是正当重命名）。
 * 区别只在初值是现有文件名、提交走 commitRename。聚焦期间吞按键，屏蔽全局快捷键误触。
 */
function RenameInput({
  rename,
  onChange,
  onCommit,
  onCancel,
}: {
  rename: PendingRename;
  onChange: (name: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, baseNameEnd(el.value)); // 只预选基名，扩展名不选中（防一打字连 .md 替换掉）
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <input
        ref={inputRef}
        value={rename.name}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onCommit}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className="min-w-0 flex-1 rounded-sm border border-accent bg-canvas px-1 text-sm text-text-primary outline-none"
      />
      {rename.error && <span className="text-xs text-warn">{rename.error}</span>}
    </span>
  );
}
