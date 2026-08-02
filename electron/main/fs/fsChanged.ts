/**
 * 单文件落盘的统一变更事件（块①「统一通知」）。
 *
 * 「文件被改」是唯一事实——不因修改者是你还是 Oru 走两条路径。用户侧落盘（ws/handlers/fs.ts）
 * 与 AI 侧落盘（proposals/executeFileWriteProposal.ts）共用本构造，产出同形态 fs.changed：
 *  - `path`（目录级，项目相对，''=根）喂旧消费者 fsStore/tableStore，语义不变；
 *  - `filePath`（文件级，项目相对）喂协同接收方（编辑器合并、预览刷新）精确命中。
 */
import { relative } from 'node:path';
import type { FsChangedEvent } from '@shared/protocol';
import { toPosix } from './tree';
import { findProjectByPath } from '../projects/store';

/** 顶层文件返回 ''（项目根），与渲染端 src/lib/paths.ts 的 parentDir 同口径。 */
function parentDir(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx < 0 ? '' : relPath.slice(0, idx);
}

/** relPath 须为项目相对、POSIX 分隔。author（S27）透传，缺省不带（树操作/来源未知）。 */
export function fileChangedEvent(
  projectId: string,
  relPath: string,
  author?: FsChangedEvent['author'],
): FsChangedEvent {
  return { type: 'fs.changed', projectId, path: parentDir(relPath), filePath: relPath, author };
}

/**
 * AI 侧落盘后广播 fs.changed。AI 的 FileWriteProposal 只带绝对路径，故由绝对路径前缀反查所属项目、
 * 算出项目相对路径再广播（不取 ToolContext.activeProjectId——proposal 可能落到非活跃项目）。
 * 接线用既有动态 import 范式（执行器不静态依赖 ws/server，无循环依赖）。找不到所属项目则静默跳过。
 */
export async function broadcastFileChanged(
  absPath: string,
  author?: FsChangedEvent['author'],
): Promise<void> {
  const project = await findProjectByPath(absPath);
  if (!project) return;
  const relPath = toPosix(relative(project.path, absPath));
  const { broadcast } = await import('../ws/server');
  // 无需「await 后重检」：projectId/relPath 纯由 absPath 前缀派生（不读可变共享态）——
  // 即便项目在 await 间隙被移除，下游 fsStore/接收方按 projectId 过滤，对已移除项目的广播被无害忽略。
  broadcast(fileChangedEvent(project.id, relPath, author));
}
