/**
 * oru-board-img:// 自定义协议 handler——任务描述图片附件的渲染端加载通路。
 *
 * 与 oru-conv-img 同构（结构第一性：任务图落点是 USERS_DIR 下 <taskId>-images/ 隐藏区、
 * 绝对路径、只本进程写），故仿 imageProtocol.ts 的段结构校验、不 realpath；未采 oru-doc-img
 * 那套 projectId + 两道 ensureWithinProject + realpath（那是为项目内可写 .assets/ 付的复杂度，
 * 隐藏区任务图不需要）。设计论证见 docs/tech/2026-07-15-任务描述图片附件技术方案.md 一。
 *
 * URL：oru-board-img://local/<absolute-path>（host 用非空占位 'local'，同 conv-img）。
 * 安全约束：路径必须在 USERS_DIR 之下、结构恰为 <ownerId>/taskboard/<taskId>-images/<file>、
 * 扩展名在白名单内，否则 403——URL 来自渲染端可任意构造，这是读盘前最后一道闸。
 */
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { normalize, sep } from 'node:path';
import { USERS_DIR } from '../runtime/paths';

/** 扩展名 → Content-Type，与 saveAttachments 的 MIME 白名单一一对应 */
const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * 把请求 URL 解析为通过沙箱校验的绝对路径与 Content-Type；不合法返回 null、保证不 throw。
 * 独立成纯函数：Electron 之外可单测（含 attacker URL / 段结构逃逸）。
 *
 * 段结构钉死：USERS_DIR 之下必须恰是 <ownerId>/taskboard/<taskId>-images/<file> 四段——
 * 松散 includes 会被 taskboard 下旁系目录绕过。不 realpath（同 conv-img 口径）：
 * 本目录只有 saveTaskboardAttachments 写入、无 symlink 来源。
 */
export function resolveBoardImageRequest(
  url: string,
): { path: string; contentType: string } | null {
  let filePath: string;
  try {
    filePath = normalize(decodeURIComponent(new URL(url).pathname));
  } catch {
    return null;
  }
  const usersRoot = normalize(USERS_DIR) + sep;
  if (!filePath.startsWith(usersRoot)) return null;
  const segs = filePath.slice(usersRoot.length).split(sep);
  const structureOk =
    segs.length === 4 &&
    segs.every(Boolean) &&
    segs[1] === 'taskboard' &&
    segs[2].endsWith('-images');
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  const contentType = EXT_MIME[ext];
  if (!structureOk || !contentType) return null;
  return { path: filePath, contentType };
}

/** 在 app.whenReady() 之后调用，注册 oru-board-img:// 协议的请求 handler */
export function registerBoardImageProtocol(): void {
  protocol.handle('oru-board-img', async (request) => {
    const resolved = resolveBoardImageRequest(request.url);
    if (!resolved) return new Response('Forbidden', { status: 403 });
    try {
      const data = await readFile(resolved.path);
      return new Response(data, { headers: { 'Content-Type': resolved.contentType } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
