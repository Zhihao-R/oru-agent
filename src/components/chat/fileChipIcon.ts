import { File, FileCode, FileText, FileType, Image, Table2 } from 'lucide-react';
import { openableKind, type OpenableKind } from '@/lib/openProjectFile';

/**
 * 文件 chip 的图标与着色（产物条 chip 与正文路径 chip 共用一套语言）：
 * 图标按可开类型分派；md 用 accent 一点强调（设计稿），其余全灰。
 * pdf 用 FileType，与标签栏 KindIcon 同一选型。
 */
const KIND_ICON: Record<OpenableKind, typeof File> = {
  editor: FileText,
  table: Table2,
  html: FileCode,
  image: Image,
  pdf: FileType,
};

export function fileChipIcon(relPath: string): { Icon: typeof File; className: string } {
  const kind = openableKind(relPath);
  return {
    Icon: kind ? KIND_ICON[kind] : File,
    className: kind === 'editor' ? 'text-accent' : 'text-text-tertiary',
  };
}
