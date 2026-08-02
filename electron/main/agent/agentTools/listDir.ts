/**
 * list_dir AgentTool（只读）—— 列出某目录下的条目（单层）。
 *
 * 为何单独保留而非靠 bash ls（决策 5 保留判据②）：纯只读、结构化输出、零确认开销，
 * 优于 bash ls 的文本输出 + 可能触发命令审批。
 *
 * symlink 不 follow，标类型 + 指向。结果上限 + 按名称稳定排序（不依赖 OS 返回序）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { assertReadableSandbox, SandboxError } from './pathSandbox';

const MAX_ENTRIES = 200;

type Entry = { name: string; type: 'file' | 'dir' | 'symlink'; size: number; symlinkTarget?: string };

const TOOL_DESC = `列出一个目录下的文件和子文件夹（只列一层，不递归）。只读、零确认。

**该用**：用户问"这个文件夹里有什么"；写文件前确认目录结构；找某个文件大概在哪个目录。

入参 path 必须是**绝对路径**，且在允许范围内（当前对话 .tool-cache/、agent 沙盒、已注册项目目录）。

symlink 不跟随，会标 [link] 并显示指向。超过 ${MAX_ENTRIES} 条会截断并标注。`;

export function makeListDirTool(): AgentTool {
  return {
    name: 'list_dir',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '要列出的目录绝对路径' } },
      required: ['path'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const { path } = (input ?? {}) as { path?: string };
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { isError: true, text: 'list_dir: path 不能为空' };
      }
      try {
        await assertReadableSandbox(path, ctx);
      } catch (e) {
        if (e instanceof SandboxError) return { isError: true, text: `list_dir: ${e.message}` };
        throw e;
      }

      let dirents;
      try {
        dirents = await fs.readdir(path, { withFileTypes: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { isError: true, text: `list_dir: 目录不存在：${path}` };
        if (code === 'ENOTDIR') return { isError: true, text: `list_dir: 不是目录：${path}` };
        if (code === 'EACCES') return { isError: true, text: `list_dir: 无权限读取目录：${path}` };
        return { isError: true, text: `list_dir: 列目录失败：${e instanceof Error ? e.message : String(e)}` };
      }

      const entries: Entry[] = [];
      for (const d of dirents) {
        const full = join(path, d.name);
        if (d.isSymbolicLink()) {
          let target = '';
          try {
            target = await fs.readlink(full);
          } catch {
            // 读不到指向——留空
          }
          entries.push({ name: d.name, type: 'symlink', size: 0, symlinkTarget: target });
        } else if (d.isDirectory()) {
          entries.push({ name: d.name, type: 'dir', size: 0 });
        } else {
          let size = 0;
          try {
            size = (await fs.stat(full)).size;
          } catch {
            // stat 失败——size 留 0
          }
          entries.push({ name: d.name, type: 'file', size });
        }
      }

      // 稳定排序：目录在前，再按名称——不依赖 OS 返回序
      entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

      const truncated = entries.length > MAX_ENTRIES;
      const shown = truncated ? entries.slice(0, MAX_ENTRIES) : entries;

      const lines = shown.map((e) => {
        if (e.type === 'dir') return `[dir]  ${e.name}/`;
        if (e.type === 'symlink') return `[link] ${e.name} -> ${e.symlinkTarget || '?'}`;
        return `[file] ${e.name} (${formatSize(e.size)})`;
      });
      let text = `${path}（${entries.length} 项${truncated ? `，仅显示前 ${MAX_ENTRIES}` : ''}）\n${lines.join('\n')}`;
      if (truncated) text += `\n… 已截断，共 ${entries.length} 项，超过 ${MAX_ENTRIES} 条上限`;

      return { text, structured: { path, count: entries.length, truncated } };
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
