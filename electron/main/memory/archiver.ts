/**
 * 归档存量兜底任务（S35·G37 后）
 *
 * 取代/退休时已「标记即物理移入 archived/」（store.markEpisodeSuperseded / markEpisodeRetired）——
 * 正常路径不再依赖本任务。它退化为**存量兜底**：扫所有 status=superseded / retired 却仍留在活跃目录
 * 的 episode（历史遗留，或极少数 relocate 移动失败的），一并搬进 <scope>/episodes/archived/、从索引移除。
 * 不再设 90 天门槛——归档可逆（工具仍搜得到），标记即该移，兜底也就该尽早把漏网的搬走。
 *
 * 归档不删——已被取代/退休的 episode 是时间线的一部分，仍可 query_episodes(includeArchived=true) 查到。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  agentArchivedEpisodesDir,
  agentEpisodesDir,
  memoryRoot,
  projectArchivedEpisodesDir,
  projectEpisodesDir,
} from './paths';
import { readMarkdownFile } from '../fs/frontmatter';
import { removeIndexEntry } from './store';

export async function archiveOldSuperseded(ownerId: string): Promise<number> {
  let count = 0;

  // agents/<name>/episodes/
  const agentsDir = join(memoryRoot(ownerId), 'agents');
  count += await scan(agentsDir, ownerId, false);
  // projects/<id>/episodes/
  const projectsDir = join(memoryRoot(ownerId), 'projects');
  count += await scan(projectsDir, ownerId, true);
  return count;
}

async function scan(
  rootDir: string,
  ownerId: string,
  underProjects: boolean,
): Promise<number> {
  let scopeDirs: import('node:fs').Dirent[];
  try {
    scopeDirs = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  let count = 0;
  for (const scope of scopeDirs) {
    if (!scope.isDirectory()) continue;
    const epDir = underProjects
      ? projectEpisodesDir(ownerId, scope.name)
      : agentEpisodesDir(ownerId, scope.name);
    const archivedDir = underProjects
      ? projectArchivedEpisodesDir(ownerId, scope.name)
      : agentArchivedEpisodesDir(ownerId, scope.name);
    let files: string[];
    try {
      files = await fs.readdir(epDir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.md')) continue;
      const abs = join(epDir, name);
      const stat = await fs.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) continue;
      const f = await readMarkdownFile(abs).catch(() => null);
      if (!f) continue;
      const data = f.data as Record<string, unknown>;
      // retired 与 superseded 都该归档——留在顶层目录会无限堆积，每次快照构建都要读其
      // frontmatter 再丢弃。正常已由标记即移入处理，这里只兜历史遗留 / 移动失败的漏网条。
      if (data.status !== 'superseded' && data.status !== 'retired') continue;
      // 移到 archived/
      await fs.mkdir(archivedDir, { recursive: true });
      const dest = join(archivedDir, name);
      await fs.rename(abs, dest).catch(() => null);
      // 从 index 删（如果还在的话）
      const rel = abs.slice(memoryRoot(ownerId).length + 1).split(/[\\/]/).join('/');
      await removeIndexEntry(ownerId, rel).catch(() => null);
      count += 1;
    }
  }
  return count;
}
