/**
 * oru-conv-img:// 自定义协议 handler——对话图片附件的渲染端加载通路。
 *
 * 解决问题：与 oru-avatar:// / oru-crop:// / oru-toolimg:// 同——主窗口 `<img>` 受
 * webSecurity 拦不能 file://。hydrateAttachmentDisplayUrls 输出本 scheme 的 URL，
 * main 进程在此校验路径后从磁盘读取并返回。
 *
 * URL 格式：oru-conv-img://local/<absolute-path>
 *   host 用非空占位 'local'（理由见 TwinAvatar：standard scheme 空 host 时
 *   Chromium 会把 path 首段提升成 host 并 lowercase 化）。
 *
 * 安全约束：路径必须在 USERS_DIR 之下、且位于 conversations 的 <convId>-images/
 * 目录里、扩展名在图片白名单内，否则 403——URL 来自渲染端，可被任意构造，
 * 这里是读盘前的最后一道闸（hydrate 侧的 ensureWithinRoot 防不了手搓 URL）。
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
 * 把请求 URL 解析为通过沙箱校验的绝对路径与 Content-Type；不合法返回 null、保证不 throw
 * （windowOpenHandler 在 main 进程同步调用它，渲染端的恶意 URL 不能炸出未捕获异常）。
 * 独立成纯函数：协议 handler 本体离不开 Electron，路径校验逻辑在这里单测。
 *
 * 校验是钉死目录结构而非子串匹配：normalize 折叠 ../ 后，USERS_DIR 之下必须恰好是
 * <ownerId>/conversations/<agentId>/<convId>-images/<file> 五段——松散的 includes 会被
 * conversations 下的旁系目录（如 <convId>-tool-cache/ 里工具自建的 *-images/）绕过。
 * 不做 realpath（toolImageProtocol 的口径）：本目录只有 saveAttachments 写入、无 symlink 来源，
 * 且 windowOpenHandler 的同步调用容不下读盘。
 */
export function resolveConvImageRequest(
  url: string,
): { path: string; contentType: string } | null {
  let filePath: string;
  try {
    // decodeURIComponent 对畸形 % 序列抛 URIError，与 URL 解析一起接住
    filePath = normalize(decodeURIComponent(new URL(url).pathname));
  } catch {
    return null;
  }
  const usersRoot = normalize(USERS_DIR) + sep;
  if (!filePath.startsWith(usersRoot)) return null;
  const segs = filePath.slice(usersRoot.length).split(sep);
  const structureOk =
    segs.length === 5 &&
    segs.every(Boolean) &&
    segs[1] === 'conversations' &&
    segs[3].endsWith('-images');
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  const contentType = EXT_MIME[ext];
  if (!structureOk || !contentType) return null;
  return { path: filePath, contentType };
}

/** 在 app.whenReady() 之后调用，注册 oru-conv-img:// 协议的请求 handler */
export function registerConvImageProtocol(): void {
  protocol.handle('oru-conv-img', async (request) => {
    const resolved = resolveConvImageRequest(request.url);
    if (!resolved) return new Response('Forbidden', { status: 403 });
    try {
      const data = await readFile(resolved.path);
      return new Response(data, { headers: { 'Content-Type': resolved.contentType } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
