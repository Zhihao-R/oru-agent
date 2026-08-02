import { FileText, FileCode2, FileImage, Table2, Layers, FileType, FileSpreadsheet } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { TabKind } from '@/stores/workspaceStore';

/**
 * 标签的类型图标——标签栏与溢出菜单共用（两处同一套 kind→图标映射，加查看器 kind 只改这里）。
 * 13px / strokeWidth 1.3（双行壳收敛）；活跃染 accent、非活跃降到最弱 quaternary。
 */
export function KindIcon({ kind, active }: { kind: TabKind; active: boolean }): JSX.Element {
  const cls = cn('h-[13px] w-[13px] shrink-0', active ? 'text-accent' : 'text-text-quaternary');
  switch (kind) {
    case 'editor':
      return <FileText className={cls} strokeWidth={1.3} />;
    case 'table':
      return <Table2 className={cls} strokeWidth={1.3} />;
    case 'xlsx':
      return <FileSpreadsheet className={cls} strokeWidth={1.3} />;
    case 'html':
      return <FileCode2 className={cls} strokeWidth={1.3} />;
    case 'image':
      return <FileImage className={cls} strokeWidth={1.3} />;
    case 'deck':
      return <Layers className={cls} strokeWidth={1.3} />;
    case 'pdf':
      return <FileType className={cls} strokeWidth={1.3} />;
  }
}
