/**
 * 任务描述图片附件——把 base64 图片落盘到任务目录 taskboard/<taskId>-images/。
 *
 * 与对话图（conversations/attachments.ts）共用校验 / 压缩内核（prepareAttachments），
 * 只是落点与 relPath 前缀不同：任务图挂在 BoardTask 上、无 convId，故独立目录。
 * 渲染端加载走 oru-board-img://（boardImageProtocol.ts）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BoardTask, ChatAttachment } from '@shared/types';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { taskboardDir, taskboardImagesDir } from '../runtime/paths';
import { ensureWithinRoot } from '../fs/frontmatter';
import {
  MIME_TO_EXT,
  prepareAttachments,
  type IncomingAttachment,
} from '../conversations/attachments';

/**
 * 校验 + 落盘一组任务图，返回可挂到 BoardTask.attachments 的形态。
 * 文件名用 randomUUID——一个任务跨多次保存累积图片，需全局唯一避免撞名。
 * 任一失败抛 AttachmentError（写盘前校验，无半写），由 handler 翻成回执。
 */
export async function saveTaskboardAttachments(
  taskId: string,
  items: IncomingAttachment[],
): Promise<ChatAttachment[]> {
  const prepared = await prepareAttachments(items);
  if (prepared.length === 0) return [];

  const ownerId = getCurrentOwnerId();
  const dir = taskboardImagesDir(ownerId, taskId);
  await fs.mkdir(dir, { recursive: true });

  const out: ChatAttachment[] = [];
  for (const p of prepared) {
    const fileName = `${randomUUID()}.${MIME_TO_EXT[p.mediaType]}`;
    await fs.writeFile(join(dir, fileName), p.buffer);
    out.push({
      kind: 'image',
      relPath: `${taskId}-images/${fileName}`,
      mediaType: p.mediaType,
      bytes: p.bytes,
      filename: p.filename,
    });
  }
  return out;
}

/**
 * 给 BoardTask.attachments 填渲染端可用的 oru-board-img:// URL（file:// 会被 webSecurity 拦）。
 * 落盘 task.json 不带 displayUrl；get / comments 出口 hydrate 一次。
 * ensureWithinRoot 防 relPath 越界——保证 URL 不指向 taskboard/ 之外。
 */
export function hydrateTaskboardDisplayUrls(task: BoardTask): BoardTask {
  if (!task.attachments || task.attachments.length === 0) return task;
  const ownerId = getCurrentOwnerId();
  const root = taskboardDir(ownerId);
  return {
    ...task,
    attachments: task.attachments.map((a) => {
      if (!a.relPath || a.relPath.trim() === '') return { ...a, displayUrl: undefined };
      let abs: string;
      try {
        abs = ensureWithinRoot(root, a.relPath);
      } catch {
        return { ...a, displayUrl: undefined }; // 越界：占位不阻断
      }
      return { ...a, displayUrl: `oru-board-img://local${encodeURI(abs)}` };
    }),
  };
}

/** 删任务时清理其图片目录（不存在静默通过）。本期只软删（进回收站保留），未接调用；硬删时用。 */
export async function deleteTaskboardImages(taskId: string): Promise<void> {
  const ownerId = getCurrentOwnerId();
  await fs.rm(taskboardImagesDir(ownerId, taskId), { recursive: true, force: true });
}
