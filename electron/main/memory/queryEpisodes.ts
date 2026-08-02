/**
 * episode 结构化查询 —— query_episodes 工具与 capture 共用的唯一遍历实现。
 *
 * 为什么抽出来：过滤逻辑原先内联在 query_episodes 这个 AgentTool 的闭包里，而 capture 走
 * runOneShot、没有工具调用能力，调不到它。两处各写一份遍历必然漂移（sources 口径、archived
 * 排除、frontmatter 解析各一套），所以做成模块级函数，两边共用。
 *
 * 返回结构化命中而不是渲染好的索引行：capture 要正文、工具要索引行，渲染各自在外面做。
 */
import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import { parseFrontmatter } from '../fs/frontmatter';
import { compressPath } from './compressedPath';
import { memoryRoot, isSkippedMemoryDir } from './paths';

export type EpisodeFilter = {
  tag?: string;
  type?: string;
  projectId?: string;
  /** episode 的 sources 与之求交，命中任一即算命中 */
  sources?: string[];
  /** 默认只看 active；true 时连 archived 目录与非 active 状态一起返回 */
  includeArchived?: boolean;
};

export type EpisodeHit = {
  /** 压缩路径——模型面的 episode id */
  compressedPath: string;
  title: string;
  description: string;
  tags: string[];
  type: string;
  /** frontmatter 之后的正文 */
  body: string;
  mtimeMs: number;
};

/**
 * 扫 agents/ 与 projects/ 下的全部 episode，按 filter 过滤。
 * 结果按 mtime 倒序（同 mtime 按压缩路径升序）——顺序确定，调用方截前 N 条即"最近 N 条"。
 * 不设条数上限：episode 数量有界，截断交给调用方按自己的预算做。
 */
export async function queryEpisodes(
  ownerId: string,
  filter: EpisodeFilter = {},
): Promise<EpisodeHit[]> {
  const root = memoryRoot(ownerId);
  const hits: EpisodeHit[] = [];

  async function visitDir(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        // archived 仅在 includeArchived=true 时进入；trash / 点目录（迁移备份）永远不进
        if (e.name === 'archived' && !filter.includeArchived) continue;
        if (isSkippedMemoryDir(e.name)) continue;
        await visitDir(abs);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;

      const text = await fs.readFile(abs, 'utf-8').catch(() => '');
      if (!text) continue;
      const parsed = parseFrontmatter(text);
      const data = parsed.data as Record<string, unknown>;
      // 无 frontmatter 的 md（档案文档等）不是 episode
      if (Object.keys(data).length === 0) continue;

      const status = (data.status as string) ?? 'active';
      if (status !== 'active' && !filter.includeArchived) continue;
      const epType = (data.type as string) ?? '';
      if (filter.type && epType !== filter.type) continue;
      const tags = (data.tags as string[] | undefined) ?? [];
      if (filter.tag && !tags.includes(filter.tag)) continue;
      const epSources = (data.sources as string[] | undefined) ?? [];
      if (
        filter.sources &&
        filter.sources.length > 0 &&
        !filter.sources.some((s) => epSources.includes(s))
      )
        continue;

      const rel = abs.slice(root.length + 1).split(sep).join('/');
      if (filter.projectId && !rel.startsWith(`projects/${filter.projectId}/`)) continue;
      let compressed: string;
      try {
        compressed = compressPath(rel);
      } catch {
        continue; // 非 episode 路径（档案文档等）
      }
      const stat = await fs.stat(abs).catch(() => null);
      hits.push({
        compressedPath: compressed,
        title: (data.title as string) ?? '',
        description: (data.description as string) ?? '',
        tags,
        type: epType,
        body: parsed.content.trim(),
        mtimeMs: stat?.mtimeMs ?? 0,
      });
    }
  }

  await visitDir(join(root, 'agents'));
  await visitDir(join(root, 'projects'));

  hits.sort((a, b) =>
    b.mtimeMs - a.mtimeMs || a.compressedPath.localeCompare(b.compressedPath),
  );
  return hits;
}
