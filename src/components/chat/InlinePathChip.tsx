import { useEffect } from 'react';
import { candidateRelPath } from '@/lib/pathChip';
import { openProjectFile } from '@/lib/openProjectFile';
import { useProjectStore } from '@/stores/projectStore';
import { ensurePathChecked, pathExistsKey, usePathExistsStore } from '@/stores/pathExistsStore';
import { fileChipIcon } from './fileChipIcon';

/**
 * 正文行内 code 的路径 chip（2026-07-20 拍板：矩形 3px，与消息内小件同一形状类）。
 *
 * 两道闸都过才成 chip：形状是可开文件路径（candidateRelPath）+ 文件真实存在
 * （pathExistsStore 异步探测）。探测未回 / 不存在 / 无活跃项目时渲染普通 code，
 * 存在性确认后就地升级——不闪、不空占位。
 */
export function InlinePathChip({ text }: { text: string }) {
  const projectId = useProjectStore((s) => s.activeProjectId);
  const root = useProjectStore((s) =>
    s.activeProjectId ? (s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null) : null,
  );
  const rel = projectId && root ? candidateRelPath(text, root) : null;
  const exists = usePathExistsStore((s) => (projectId && rel ? s.known[pathExistsKey(projectId, rel)] : undefined));
  useEffect(() => {
    if (projectId && root && rel) ensurePathChecked(projectId, root, rel);
  }, [projectId, root, rel]);

  if (!projectId || !rel || exists !== true) return <code>{text}</code>;
  const { Icon, className } = fileChipIcon(rel);
  return (
    <button
      type="button"
      title={rel}
      onClick={() => openProjectFile(projectId, rel)}
      className="inline-flex max-w-full items-center gap-1 rounded-xs border border-border bg-sunken px-1.5 py-px align-baseline font-mono text-xs text-text-primary transition-colors duration-150 hover:border-accent-line hover:bg-accent-soft"
    >
      <Icon size={11} strokeWidth={1.8} className={`shrink-0 ${className}`} />
      <span className="truncate">{text}</span>
    </button>
  );
}
