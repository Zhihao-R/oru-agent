import { basename } from '@/lib/paths';
import { fileKind } from '@/lib/fileKind';
import { makeTab, useWorkspaceStore, type TabKind } from '@/stores/workspaceStore';
import { useEditorStore } from '@/stores/editorStore';
import { useTableStore } from '@/stores/tableStore';
import { useHtmlAnnotStore } from '@/stores/htmlAnnotStore';
import { usePdfStore } from '@/stores/pdfStore';
import { useProjectStore } from '@/stores/projectStore';

/**
 * 对话组件「在 Oru 中打开文件」的统一通路。
 *
 * 与文件树 activate 的文件分支同源（fileKind 判型 → openTab 落列 → 各查看器建桶），
 * 消费方：工具详情浮层打开按钮 / 回合产物条 chip / 正文路径 chip。
 * 只覆盖能开成右栏标签的五类；xlsx（点击=导入转换）与代码文件等 other 不在此列。
 */
export type OpenableKind = Extract<TabKind, 'editor' | 'table' | 'html' | 'image' | 'pdf'>;

const KIND_MAP: Partial<Record<ReturnType<typeof fileKind>, OpenableKind>> = {
  markdown: 'editor',
  csv: 'table',
  html: 'html',
  image: 'image',
  pdf: 'pdf',
};

/**
 * 绝对路径 → 项目相对路径（工具 input.path 是绝对路径）；不在该项目内返回 null。
 *
 * 决策（2026-07-27 拆分原 2026-07-20 口径）：**显示按归属项目、打开按当前项目**。
 * 产物条是对话历史的一部分，记录「这一轮改了什么文件」这个已发生的事实——不因用户此刻
 * 切到别的项目而消失（显示走 owningProject 反查归属）。打开入口维持只认当前活跃项目：
 * Tab id（`${kind}:${ref}`）不含 projectId，跨项目开同名相对路径会撞标签。
 * 要放开跨项目打开须先给 Tab 身份带上项目维度。
 */
export function projectRelPath(projectId: string, absPath: string): string | null {
  const root = useProjectStore.getState().projects.find((p) => p.id === projectId)?.path;
  // `${root}/` 前缀判定已规避 /a/proj 与 /a/proj-2 互为前缀的误判
  if (!root || !absPath.startsWith(`${root}/`)) return null;
  return absPath.slice(root.length + 1);
}

/**
 * 按绝对路径在全部项目里反查归属；不属于任何项目返回 null。
 * 项目根可以嵌套（addProject 只挡重复不禁嵌套）：取**最长前缀**命中，文件归最内层项目——
 * 否则内层项目的文件会被判给外层、在 UI 上呈现成「别的项目的文件」而点不开。
 */
export function owningProject(absPath: string): { id: string; relPath: string } | null {
  let best: { id: string; path: string } | null = null;
  for (const p of useProjectStore.getState().projects) {
    if (!absPath.startsWith(`${p.path}/`)) continue;
    if (!best || p.path.length > best.path.length) best = p;
  }
  return best ? { id: best.id, relPath: absPath.slice(best.path.length + 1) } : null;
}

/** 相对路径能否在右栏打开；不能则 null（调用方据此隐藏打开入口） */
export function openableKind(relPath: string): OpenableKind | null {
  const name = basename(relPath);
  return KIND_MAP[fileKind({ name, path: relPath, isDirectory: false })] ?? null;
}

/** 在右栏打开项目内文件（已开则切过去）。不可打开类型返回 false、零副作用。 */
export function openProjectFile(projectId: string, relPath: string): boolean {
  const kind = openableKind(relPath);
  if (!kind) return false;
  useWorkspaceStore.getState().openTab(makeTab({ kind, projectId, ref: relPath, title: basename(relPath) }));
  switch (kind) {
    case 'editor':
      void useEditorStore.getState().open(projectId, relPath); // 建内容桶（已开则 no-op，保留现场）
      break;
    case 'table':
      void useTableStore.getState().open(projectId, relPath);
      break;
    case 'html': {
      // WS 用绝对路径、桶 key 用相对 ref——同文件树 activate 的 html 分支
      const root = useProjectStore.getState().projects.find((p) => p.id === projectId)?.path;
      if (root) void useHtmlAnnotStore.getState().activate(relPath, `${root}/${relPath}`);
      break;
    }
    case 'pdf': {
      // 桶纯前端、同步建（已开则保留现场）——同文件树 activate 的 pdf 分支
      const root = useProjectStore.getState().projects.find((p) => p.id === projectId)?.path;
      if (root) usePdfStore.getState().open(relPath, `${root}/${relPath}`);
      break;
    }
    case 'image':
      break; // 图片无桶，落标签即完成
  }
  return true;
}
