/**
 * md 文档本地图片上传——粘贴 / 拖入 / 裁剪输出共用：校验 → base64 → IPC 落进当前文档的
 * `<文档名>.assets/`，回相对引用（供编辑器插 `![](ref)`）。
 *
 * 落盘真伪/并发取名由主进程 writeImageToAssets 的 wx 原子创建裁决；渲染端只做格式/大小预判。
 */
import type { FsImageWrittenEvent } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { fileToBase64 } from './fileToBase64';
import { ALLOWED_IMAGE_MIME, MAX_BYTES_PER_IMAGE } from './imageAttachments';

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** 受支持图片 mime → 扩展名（含点）；非图片返回 null。 */
export function imageExtForMime(mime: string): string | null {
  return MIME_EXT[mime] ?? null;
}

/** 去掉文件名扩展名取基名（截图常无名）。 */
function baseNameNoExt(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? '';
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/**
 * 把一张图落进 docPath 文档旁的 assets，返回相对引用；非图 / 超 5 MB / 落盘失败 → null。
 */
export async function uploadDocImage(
  projectId: string,
  docPath: string,
  file: File,
): Promise<string | null> {
  if (!ALLOWED_IMAGE_MIME.has(file.type)) return null;
  const ext = imageExtForMime(file.type);
  if (!ext) return null;
  if (file.size > MAX_BYTES_PER_IMAGE) return null;

  const base64 = await fileToBase64(file);
  // '图片' 是落盘文件名兜底（写入用户文档的内容，类②）——不随界面语言翻译，固定中文
  const preferredBase = baseNameNoExt(file.name) || '图片';
  try {
    const res = await wsClient.request<FsImageWrittenEvent>({
      type: 'fs.writeImage',
      projectId,
      docPath,
      base64,
      preferredBase,
      ext,
    });
    return res.type === 'fs.image.written' ? res.ref : null;
  } catch {
    return null;
  }
}
