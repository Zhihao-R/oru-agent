/**
 * download_image 的纯函数：入参校验 + 文件名净化 + 相对引用路径推导（单测覆盖）。
 *
 * 文件名净化是硬要求（决策 5）：
 *  - 去 querystring/fragment——否则存成 `images/x.png?v=1` 会绕过缺图扫描 scanMissingImages
 *    （history.ts 不拆 querystring）。
 *  - 非法字符替换、保证有图片后缀。
 *  - 重名后缀（-2/-3）由工具侧做（要 fs 探测），不在此纯函数里。
 */
import { basename, dirname } from 'node:path';

export type ParsedDownloadInput = { url: string; dest: string } | { error: string };

export function parseDownloadInput(input: unknown): ParsedDownloadInput {
  const { url, dest } = (input ?? {}) as { url?: unknown; dest?: unknown };
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { error: 'download_image: url 不能为空' };
  }
  if (typeof dest !== 'string' || dest.trim().length === 0) {
    return { error: 'download_image: dest 不能为空（要绝对路径，如 <deckPath>/images/hero.jpg）' };
  }
  return { url: url.trim(), dest: dest.trim() };
}

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/**
 * 把 dest 的文件名净化成权威落盘名（不含 querystring/fragment、合法字符、有图片后缀）。
 * mimeExt 是 magic-byte 实测出的扩展名——当原名缺图片后缀时补上它（以实际字节为准）。
 */
export function finalizeFilename(dest: string, mimeExt: string): string {
  let name = basename(dest);
  // 去 querystring / fragment（? 或 # 之后）
  name = name.split('?')[0].split('#')[0];
  // 拆出扩展名
  const dot = name.lastIndexOf('.');
  let stem = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  // 净化 stem：非法字符 + 空白 → -，合并连续 -，去首尾 -
  stem = stem
    .replace(/[/\\:*?"<>|\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!stem) stem = 'image';
  // 扩展名：原名是合法图片后缀就保留；否则用实测 mimeExt
  if (!IMG_EXTS.has(ext)) ext = mimeExt;
  return `${stem}.${ext}`;
}

/**
 * 写进 <img src> 的相对引用路径——取 dest 的父目录名 + 最终落盘名。
 * deck 约定父目录是 images/，故通常得到 `images/hero-2.jpg`；父目录名异常时退回 `images`。
 */
export function relImagePath(dest: string, finalName: string): string {
  const parent = basename(dirname(dest)) || 'images';
  return `${parent}/${finalName}`;
}
