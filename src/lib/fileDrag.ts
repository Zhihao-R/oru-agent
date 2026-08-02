import type { DragEvent } from 'react';

/**
 * 应用内文件拖拽协议的单一真源——文件树、文件标签作为拖拽源，对话/评论输入框作为落点共用。
 * 自定义 MIME 把"应用内文件引用"和系统图片拖入区分开（落点据此判定）。
 */
export const FILE_DRAG_MIME = 'application/x-oru-file';

/** paths 是被拖整组（多选时全选）；path/name 是被拖主项（落点单文件引用读它）。 */
export type FileDragPayload = { paths: string[]; path: string; name: string };

export function setFileDragData(e: DragEvent, payload: FileDragPayload): void {
  e.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify(payload));
}

export function readFileDragPayload(e: DragEvent): FileDragPayload | null {
  const raw = e.dataTransfer.getData(FILE_DRAG_MIME);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as FileDragPayload;
    return Array.isArray(p.paths) ? p : null;
  } catch {
    return null;
  }
}
