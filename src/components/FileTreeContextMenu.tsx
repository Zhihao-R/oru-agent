import {
  Copy,
  CopyPlus,
  FilePlus,
  FolderPlus,
  FolderSearch,
  Layers,
  Pencil,
  Quote,
  TableProperties,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FileNode } from '@shared/types';
import { fileKind } from '@/lib/fileKind';
import type { NewKind } from '@/stores/fsStore';
import { ContextMenu, type MenuRow } from '@/components/ui/ContextMenu';

/**
 * 文件树右键菜单（文件引用进对话 §3 起家，后扩成文件管理总入口）。
 *
 * StatusMenu 能借鉴的是关闭交互 / Esc / viewport clamp，但它锚到元素下沿；右键菜单锚到**鼠标
 * 坐标**（clientX/clientY），定位内核单独写。受控组件——菜单项按节点类型决定：
 *   - 空白处（node=null）→ 只「在此新建」（落点项目根）
 *   - 目录 →「加入演示稿」+ 重命名 / 副本 / 复制路径 / 在访达显示 / 移到回收站 +「在此新建」（落点其内）
 *   - html 文件 →「引用到对话」+「加入演示稿」+ 文件管理项（无新建项）
 *   - 其它文件 →「引用到对话」+ 文件管理项（无新建项）
 *
 * targets 是批量动作（引用 / 副本 / 删除）真正作用的路径集——右键多选里的某一项时由 FileTree
 * 传入整个选区；单选/未选中目标时即该节点一项。逐项动作（重命名 / 复制路径 / 在访达显示）只认
 * node 单节点（多选时禁用，见 FileTree 取舍）。
 *
 * 菜单经 createPortal 挂到 body：侧栏祖先带 transform（展开/收起动画），会成为 fixed 的包含块，
 * 不脱离则菜单偏移、被侧栏裁剪（与 Dialog 同一套修法）。
 */
export type ContextMenuState = {
  /** node=null 表示右键空白处 */
  node: FileNode | null;
  x: number;
  y: number;
  /** 批量动作作用的路径集（空白处为空） */
  targets: string[];
};

export type FileTreeContextMenuProps = {
  state: ContextMenuState;
  onClose: () => void;
  onReference: (paths: string[]) => void;
  onAdoptDeck: (node: FileNode) => void;
  onRename: (node: FileNode) => void;
  onDuplicate: (paths: string[]) => void;
  onCopyPath: (node: FileNode) => void;
  onReveal: (node: FileNode) => void;
  onTrash: (paths: string[]) => void;
  onNewFile: (kind: NewKind, parentDir: string) => void;
};

/** 新建项的落点：右键文件夹 → 其内；右键文件 → 同级目录；空白处 → 项目根。 */
function newParentDir(node: FileNode | null): string {
  if (!node) return '';
  if (node.isDirectory) return node.path;
  const i = node.path.lastIndexOf('/');
  return i === -1 ? '' : node.path.slice(0, i);
}

export function FileTreeContextMenu({
  state,
  onClose,
  onReference,
  onAdoptDeck,
  onRename,
  onDuplicate,
  onCopyPath,
  onReveal,
  onTrash,
  onNewFile,
}: FileTreeContextMenuProps): JSX.Element | null {
  const { t } = useTranslation('files');
  const { node, x, y, targets } = state;

  const parentDir = newParentDir(node);
  const newItems: MenuRow[] = [
    { key: 'new-md', label: t('menu.newMd'), icon: FilePlus, onClick: () => onNewFile('md', parentDir) },
    { key: 'new-csv', label: t('menu.newCsv'), icon: TableProperties, onClick: () => onNewFile('csv', parentDir) },
    { key: 'new-folder', label: t('menu.newFolder'), icon: FolderPlus, onClick: () => onNewFile('folder', parentDir) },
  ];

  let rows: MenuRow[];
  if (!node) {
    rows = newItems;
  } else {
    const open: MenuRow[] = node.isDirectory
      ? [{ key: 'adopt', label: t('menu.adoptDeck'), icon: Layers, onClick: () => onAdoptDeck(node) }]
      : fileKind(node) === 'html'
        ? [
            { key: 'reference', label: t('menu.reference'), icon: Quote, onClick: () => onReference(targets) },
            { key: 'adopt', label: t('menu.adoptDeck'), icon: Layers, onClick: () => onAdoptDeck(node) },
          ]
        : [{ key: 'reference', label: t('menu.reference'), icon: Quote, onClick: () => onReference(targets) }];
    // 多选时逐项动作（重命名 / 复制路径 / 在访达显示）认 node 单节点，仍允许——以右键的那个为准
    const manage: MenuRow[] = [
      { key: 'rename', label: t('menu.rename'), icon: Pencil, onClick: () => onRename(node) },
      { key: 'duplicate', label: t('menu.duplicate'), icon: CopyPlus, onClick: () => onDuplicate(targets) },
      { key: 'copy-path', label: t('menu.copyPath'), icon: Copy, onClick: () => onCopyPath(node) },
      { key: 'reveal', label: t('menu.reveal'), icon: FolderSearch, onClick: () => onReveal(node) },
      { key: 'trash', label: t('menu.trash'), icon: Trash2, onClick: () => onTrash(targets) },
    ];
    // 「在此新建」只在目录（落点其内）和空白处（落点项目根）给——右键具体文件不挂新建项
    rows = node.isDirectory
      ? [...open, { key: 'sep-1', separator: true }, ...manage, { key: 'sep-2', separator: true }, ...newItems]
      : [...open, { key: 'sep-1', separator: true }, ...manage];
  }

  return <ContextMenu x={x} y={y} rows={rows} onClose={onClose} />;
}
