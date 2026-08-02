import type { ToolCall } from '@shared/types';
import type { FileChangeOp } from '@shared/agent/structuredMarkers';
import { normalizeToolName } from '@shared/agent/toolName';
import { readStructuredMarkers } from '@shared/agent/structuredMarkers';
import { openableKind, owningProject } from '@/lib/openProjectFile';

/**
 * 「这次工具调用动了哪些文件」的唯一判定——工具详情浮层打开按钮与「本轮文件变更」条共用。
 *
 * 只采信 result.structured 里的事实标记（主进程各写类工具在**真正发生后**附带；bash 是
 * 调用当下预期申报 + 执行后核验，未通过核验的不进标记）：审批被拒 / 只读挡拦下 / 历史消息
 * 都没有标记，一律不显示——标记即事实，不做文案猜测。新形状 fileChanges 表达四种操作
 * （PRD 2026-07-27 第 7 项·决策二），遗留 file 形状（2026-07-28 前落盘）映射为 create/modify。
 *
 * 显示判定与打开判定分离（2026-07-27）：本判定只回答「动了哪个项目的哪个文件」（按归属项目
 * 反查，不看当前活跃项目）；「能不能点开」由 canOpenTarget 统一叠加「仍存在 + 当前活跃项目 +
 * 类型可开」。
 */
export type FileChangeTarget = {
  /** 归属项目（按绝对路径反查），不一定是当前活跃项目 */
  projectId: string;
  relPath: string;
  op: FileChangeOp;
  /** 类型能否开成右栏标签（代码文件等 other 类型只展示不可点）；存在性/跨项目由 canOpenTarget 叠加 */
  openable: boolean;
  /** move/rename：旧路径的 `${projectId}:${relPath}`，供聚合层把同轮旧路径条目并过来 */
  fromKey?: string;
};

// fail-closed 白名单：只采信这些工具的标记——不认识的工具（外部 MCP 等）即使带同形状字段也不采信
const CHANGE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'convert_csv_encoding',
  'manage_files',
  'bash',
]);

function toTarget(change: { path: string; op: FileChangeOp; from?: string }): FileChangeTarget | null {
  const owner = owningProject(change.path);
  if (!owner) return null;
  const target: FileChangeTarget = {
    projectId: owner.id,
    relPath: owner.relPath,
    op: change.op,
    openable: openableKind(owner.relPath) !== null,
  };
  if (change.from) {
    const fromOwner = owningProject(change.from);
    if (fromOwner) target.fromKey = `${fromOwner.id}:${fromOwner.relPath}`;
  }
  return target;
}

/** 该调用动了哪些项目文件；非写盘工具 / 无标记 / 不属于任何项目的路径不出现 */
export function fileChangeTargets(tool: ToolCall): FileChangeTarget[] {
  if (tool.status !== 'success' || tool.result?.isError) return [];
  if (!CHANGE_TOOLS.has(normalizeToolName(tool.name))) return [];
  const markers = readStructuredMarkers(tool.result?.structured);
  const changes = markers.fileChanges ?? [];
  const legacy = markers.file; // 遗留形状：created=true → create、false → modify
  const all =
    changes.length > 0 || !legacy || typeof legacy.path !== 'string'
      ? changes
      : [{ path: legacy.path, op: (legacy.created === true ? 'create' : 'modify') as FileChangeOp }];
  return all
    .filter((c) => typeof c.path === 'string')
    .map(toTarget)
    .filter((t): t is FileChangeTarget => t !== null);
}

/** 打开入口的统一判定：仍存在（本轮净状态非删除）+ 当前活跃项目 + 类型可开 */
export function canOpenTarget(target: FileChangeTarget, activeProjectId: string | null): boolean {
  return target.openable && target.op !== 'delete' && target.projectId === activeProjectId;
}
