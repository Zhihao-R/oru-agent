/**
 * Project-list 聚合视图
 *
 * 每个项目有一份 `projects/<id>/list-entry.md`（无 frontmatter，纯一段文字）。
 * 注入时聚合所有 list-entry，按 projectId 排序输出；
 * MemoryPage 渲染时聚合所有 list-entry 并附带 profile.md 的 last-updated，按时间倒序。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ProjectListEntry } from '@shared/types';
import { memoryRoot, projectListEntryPath, projectProfilePath } from './paths';
import { readMarkdownFile } from '../fs/frontmatter';
import { safeWriteAsync } from '../fs/safeWrite';

/** 读单个项目 list-entry */
export async function readProjectListEntry(
  ownerId: string,
  projectId: string,
): Promise<string> {
  try {
    return await fs.readFile(projectListEntryPath(ownerId, projectId), 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/** 写单个项目 list-entry */
export async function writeProjectListEntry(
  ownerId: string,
  projectId: string,
  summary: string,
): Promise<void> {
  const absPath = projectListEntryPath(ownerId, projectId);
  // 原子写内核自带 mkdir -p 父目录，改写既有 list-entry 不留半截
  await safeWriteAsync(absPath, summary.trim() + '\n');
}

/**
 * 列出所有 list-entry（聚合视图）。
 *
 * 默认按 projectId 升序（snapshot 注入用，保稳定）；
 * MemoryPage 用 readAllProjectListEntriesForUI 按 lastUpdated 倒序。
 */
export async function readAllProjectListEntries(
  ownerId: string,
): Promise<ProjectListEntry[]> {
  const projectsDir = join(memoryRoot(ownerId), 'projects');
  let dirs: string[];
  try {
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: ProjectListEntry[] = [];
  for (const projectId of dirs) {
    const intro = (await readProjectListEntry(ownerId, projectId)).trim();
    if (intro.length === 0) continue;
    const lastUpdated = await readProfileLastUpdated(ownerId, projectId);
    out.push({
      projectId,
      intro,
      introSnippet: truncateIntro(intro),
      lastUpdated,
    });
  }
  return out;
}

/** 给 renderer 用：按 lastUpdated 倒序（缺省值 '' 排到最后） */
export async function readAllProjectListEntriesForUI(
  ownerId: string,
): Promise<ProjectListEntry[]> {
  const entries = await readAllProjectListEntries(ownerId);
  return entries.slice().sort((a, b) => {
    if (a.lastUpdated === b.lastUpdated) return a.projectId.localeCompare(b.projectId);
    if (a.lastUpdated === '') return 1;
    if (b.lastUpdated === '') return -1;
    return a.lastUpdated < b.lastUpdated ? 1 : -1;
  });
}

/**
 * intro 截断规则：
 * 1. 取第一行
 * 2. 在第一行内取首个句号（中英文）前的内容；无句号则取整行
 * 3. 若结果 > 60 字符，截 60 + '…'
 *
 * 后端算，避免 renderer 跨平台差异。
 */
export function truncateIntro(intro: string): string {
  const firstLine = intro.split('\n')[0].trim();
  if (!firstLine) return '';
  const sentenceMatch = firstLine.match(/^([^。.!?！？]+)/);
  const candidate = sentenceMatch ? sentenceMatch[1] : firstLine;
  return candidate.length > 60 ? candidate.slice(0, 60) + '…' : candidate;
}

async function readProfileLastUpdated(ownerId: string, projectId: string): Promise<string> {
  try {
    const f = await readMarkdownFile(projectProfilePath(ownerId, projectId));
    const v = f?.data?.['last-updated'];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}
