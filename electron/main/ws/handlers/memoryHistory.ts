/**
 * memory.history.* 命令处理器（档案历史通道，Task 4）。
 *
 * 沙箱：ensureWithinRoot(memoryRoot(ownerId), relPath)——越界路径抛错，等效于 fileHistory 域的 ensureWithinProject。
 * fileKey：memoryRoot 下绝对路径，与 writeMemoryDocument / commitWorkfileWrite 的 key 一致，共享同一历史库。
 * list/get：纯读，零广播。
 * restore：真恢复（锁内 pre-restore 兜底 + 写回），广播 memory.doc.changed 通知已打开的编辑器刷新。
 */
import type { RegistrySlice } from './types';
import * as fileHistory from '../../fs/fileHistory';
import { restoreWorkfileSnapshot } from '../../fs/workfileWrite';
import { ensureWithinRoot } from '../../fs/frontmatter';
import { memoryRoot } from '../../memory/paths';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';

/** 将 relPath 解析为 memoryRoot 沙箱内的绝对路径（fileKey）。越界时 ensureWithinRoot 抛错。 */
function fileKeyFor(relPath: string): string {
  return ensureWithinRoot(memoryRoot(getCurrentOwnerId()), relPath);
}

export const memoryHistoryHandlers = {
  // 列出用户可后悔的快照（listForUser 只回 USER_VISIBLE_KINDS，滤掉 overwrite-guard 等高频内部安全网）
  'memory.history.list': async (req, { reply }) => {
    const snapshots = await fileHistory.listForUser(fileKeyFor(req.relPath));
    reply(req.reqId, { type: 'memory.history.list.result', relPath: req.relPath, snapshots });
  },
  // 读某快照内容（不落盘）
  'memory.history.get': async (req, { reply }) => {
    const content = await fileHistory.restore(fileKeyFor(req.relPath), req.snapshotId);
    reply(req.reqId, {
      type: 'memory.history.content',
      relPath: req.relPath,
      snapshotId: req.snapshotId,
      content,
    });
  },
  // 恢复快照到磁盘（锁内 pre-restore 兜底 + 写回），广播通知已打开的编辑器
  'memory.history.restore': async (req, { reply, broadcast }) => {
    const content = await restoreWorkfileSnapshot(fileKeyFor(req.relPath), req.snapshotId);
    reply(req.reqId, { type: 'memory.history.restored', relPath: req.relPath, content });
    broadcast({ type: 'memory.doc.changed', relPath: req.relPath });
  },
} satisfies RegistrySlice;
