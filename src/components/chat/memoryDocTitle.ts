/**
 * 档案类记忆的显示标题——落点浮层的标题、卡片的撤回确认与「整篇更新了…」共用同一处口径。
 *
 * 按 scope 判而非 type：type 有历史值（persona / fact / preference）要兜，scope 三值没有这层包袱。
 */
import type { TFunction } from 'i18next';
import type { MemoryRecordPayload } from '@shared/types';

/** 项目档案的 relPath 形如 projects/<id>/profile.md——payload 没带 projectId，只能从路径取 */
export function projectIdOf(relPath: string): string {
  return relPath.split('/')[1] ?? '';
}

/** t 必须是 home 命名空间的译者（about.you / about.self）。 */
export function memoryDocTitle(
  record: Pick<MemoryRecordPayload, 'scope'>,
  opts: { oruName: string; projectName: string; t: TFunction },
): string {
  if (record.scope === 'project') return opts.projectName;
  if (record.scope === 'agent') return opts.t('about.self', { name: opts.oruName });
  return opts.t('about.you');
}
