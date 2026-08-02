import { useTranslation } from 'react-i18next';
import { Copy, CopyPlus, FolderSearch, Quote } from 'lucide-react';
import { ContextMenu, type MenuRow } from '@/components/ui/ContextMenu';
import { useFsStore } from '@/stores/fsStore';
import { referenceFilesToComposer } from '@/lib/referenceFiles';

/**
 * 文件标签右键菜单：文件树菜单去掉「重命名」「移到回收站」后的四项，所有标签类型一致
 * （含 deck、含 html，html 不带「加入演示稿」）。source 由 tabSourcePath 解析好传入。
 */
export function TabContextMenu({
  x,
  y,
  source,
  onClose,
}: {
  x: number;
  y: number;
  source: { path: string; name: string };
  onClose: () => void;
}): JSX.Element {
  // 取文件树右键菜单中相同的四项——复用 files ns（单一源，不另定义）
  const { t } = useTranslation('files');
  const { path } = source;
  const rows: MenuRow[] = [
    { key: 'reference', label: t('menu.reference'), icon: Quote, onClick: () => referenceFilesToComposer([path]) },
    { key: 'duplicate', label: t('menu.duplicate'), icon: CopyPlus, onClick: () => void useFsStore.getState().duplicate(path) },
    { key: 'copy-path', label: t('menu.copyPath'), icon: Copy, onClick: () => void navigator.clipboard.writeText(path) },
    { key: 'reveal', label: t('menu.reveal'), icon: FolderSearch, onClick: () => void useFsStore.getState().reveal(path) },
  ];
  return <ContextMenu x={x} y={y} rows={rows} onClose={onClose} />;
}
