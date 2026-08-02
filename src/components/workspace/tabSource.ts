import type { Tab } from '@/stores/workspaceStore';
import { getDeckRecord } from '@/stores/artifactStore';
import { useProjectStore } from '@/stores/projectStore';
import { relativeTo } from '@/lib/paths';

/**
 * 标签 → 磁盘文件的唯一翻译点（右键菜单 / 拖拽引用都只认它）。
 * 文件类标签 ref 即项目相对路径；deck 标签 ref 是 artifactId，经记录把文件夹绝对路径转项目相对。
 * 解析不出（deck 记录未到 / 项目缺失）→ null，调用方据此静默不挂菜单 / 不可拖。
 */
export function tabSourcePath(tab: Tab): { path: string; name: string } | null {
  if (tab.kind !== 'deck') return { path: tab.ref, name: tab.title };
  const record = getDeckRecord(tab.ref);
  if (!record) return null;
  // deck 归属哪个项目是记录的性质（record.projectId），用它查项目根而非 tab.projectId——两者正常一致，但记录是真源。
  const project = useProjectStore.getState().projects.find((p) => p.id === record.projectId);
  if (!project) return null;
  return { path: relativeTo(project.path, record.path), name: tab.title };
}
