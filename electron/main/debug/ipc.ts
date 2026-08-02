/**
 * Debug 模块的 IPC handlers
 *
 * debug 数据是**历史快照**性质，不进 WS（与 settings / conversation / proposal 等实时流不同）；
 * 故走文件 + IPC 通道。后来者无须困惑"为什么这里走 IPC"。
 *
 * 4 个 handler：
 * - debug:list      列出所有 round 汇总（按一次行为粒度，左栏列表用）
 * - debug:read      读单条会话完整 ndjson 文本（前端 parseNdjson + roundId 过滤后喂 timeline）
 * - debug:openDir   在 Finder/Explorer 里打开 debug 数据目录
 * - debug:clearAll  二次确认后从磁盘删整个 debug 目录
 */

import { ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import type { RoundSummary } from '@shared/debug/types';
import { debugDir, debugConvFile } from '../runtime/paths';
import { listSessions } from './listSessions';

/** 当前 MVP 阶段固定 ownerId（详 tech design §4.6） */
const OWNER = 'local-user';

let registered = false;

export function registerDebugIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('debug:list', async (): Promise<RoundSummary[]> => {
    return await listSessions(OWNER);
  });

  ipcMain.handle(
    'debug:read',
    async (_e, dateKey: string, conversationId: string): Promise<string> => {
      const path = debugConvFile(OWNER, dateKey, conversationId);
      return await fs.readFile(path, 'utf-8');
    },
  );

  ipcMain.handle('debug:openDir', async (): Promise<void> => {
    const dir = debugDir(OWNER);
    try {
      await fs.mkdir(dir, { recursive: true }); // 没跑过对话时目录可能不存在
    } catch {
      // 创建失败：让 openPath 自己报错
    }
    await shell.openPath(dir);
  });

  ipcMain.handle('debug:clearAll', async (): Promise<void> => {
    await fs.rm(debugDir(OWNER), { recursive: true, force: true });
  });
}
