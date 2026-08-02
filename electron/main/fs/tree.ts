import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignore from 'ignore';
import type { FileNode } from '@shared/types';

const HARD_FILTER = ['node_modules', '.git', '.DS_Store', '.narrative.md'];
// 单个目录直接子项超过此数即截断，末尾以 truncated 计数告知用户（可见截断，不静默）。
// 懒加载下只读一层，故这是"单层"上限，不再是旧 buildTree 那种跨整树的全局预算。
const MAX_ENTRIES_PER_DIR = 1000;

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

async function loadGitignore(projectPath: string): Promise<ReturnType<typeof ignore>> {
  const ig = ignore();
  // 强制过滤
  ig.add(HARD_FILTER);
  const gitignorePath = join(projectPath, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      const content = await fs.readFile(gitignorePath, 'utf-8');
      ig.add(content);
    } catch {
      // 读不到就算了
    }
  }
  return ig;
}

export type DirListing = {
  entries: FileNode[];
  /** 被截断未显示的项数（0 = 未截断） */
  truncated: number;
};

/**
 * 读取 relDir 的直接子项（一层，不递归）。relDir='' 表示项目根。
 * 套用 HARD_FILTER + 项目 .gitignore 过滤；目录在前、同类按名排序；超 MAX_ENTRIES_PER_DIR 截断。
 * 目标目录读不到（已删/无权限）返回空列表而非抛错（沿用旧 walk 的容错）。
 */
export async function listDir(projectPath: string, relDir: string): Promise<DirListing> {
  const ig = await loadGitignore(projectPath);
  const abs = relDir ? join(projectPath, relDir) : projectPath;

  let dirents: import('node:fs').Dirent[] = [];
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return { entries: [], truncated: 0 };
  }

  const nodes: FileNode[] = [];
  for (const entry of dirents) {
    const rel = toPosix(relative(projectPath, join(abs, entry.name)));
    const probe = entry.isDirectory() ? `${rel}/` : rel;
    if (ig.ignores(probe)) continue;
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: rel, isDirectory: true });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: rel, isDirectory: false });
    }
  }

  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  if (nodes.length > MAX_ENTRIES_PER_DIR) {
    return {
      entries: nodes.slice(0, MAX_ENTRIES_PER_DIR),
      truncated: nodes.length - MAX_ENTRIES_PER_DIR,
    };
  }
  return { entries: nodes, truncated: 0 };
}
