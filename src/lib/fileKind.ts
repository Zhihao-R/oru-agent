import type { FileNode } from '@shared/types';

/**
 * 文件树条目的七类——各给一个一眼能分的图标、各走一条打开路径（文件树认类型 §2）。
 * 纯函数：目录统一 'folder'（不再自动辨别 deck 文件夹——散稿靠右键「加入演示稿」手动收编）；
 * 文件靠扩展名。csv 进表格视图；xlsx 点击触发导入转换（门口转 CSV，原件不动）。
 */
export type FileKind = 'folder' | 'markdown' | 'html' | 'image' | 'csv' | 'xlsx' | 'pdf' | 'other';

const MARKDOWN_EXT = new Set(['md', 'markdown', 'txt']);
const HTML_EXT = new Set(['html', 'htm']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

export function getExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '';
  return name.slice(idx + 1).toLowerCase();
}

export function fileKind(node: FileNode): FileKind {
  if (node.isDirectory) return 'folder';
  const ext = getExtension(node.name);
  if (MARKDOWN_EXT.has(ext)) return 'markdown';
  if (HTML_EXT.has(ext)) return 'html';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === 'csv') return 'csv';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'pdf') return 'pdf';
  return 'other';
}
