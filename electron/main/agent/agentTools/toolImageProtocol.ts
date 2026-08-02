/**
 * oru-toolimg:// 自定义协议 handler —— 给聊天卡显示 image_search 候选缩略图 + download_image
 * 落地图（决策 8）。
 *
 * 解决问题：与 oru-crop:// / oru-avatar:// 同——主窗口 `<img>` 受 webSecurity 拦不能 file://。
 * 注册自定义 scheme，main 进程校验路径后读盘返回字节。
 *
 * URL 格式：oru-toolimg://local<absolute-path>
 *
 * 安全约束（收窄到本能力会产出的两类位置，不放开任意文件读）：
 *   - 缩略图：落在某对话的 `<convId>-tool-cache/` 下
 *   - 落地图：落在某 deck 的 `images/` 下
 *   且后缀必须是常见图片格式。
 */
import { protocol } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import { convDir } from '../../runtime/paths';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';
import { listProjects } from '../../projects/store';
import { isWithin } from './pathSandbox';

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * 允许的根：对话目录（缩略图落在 <convId>-tool-cache 下）+ 已注册项目根（deck/images 落在其下）。
 * 用真实根锚定 + realpath 后 isWithin（同 oru-avatar:// / oru-crop:// 的根锚做法），
 * 不用子串匹配——否则任何路径里含 /images/ 段的图片文件都会被放行（任意文件读窗口）。
 */
async function allowedRoots(): Promise<string[]> {
  const roots = [convDir(getCurrentOwnerId())];
  try {
    const { projects } = await listProjects();
    for (const p of projects) if (p.path) roots.push(p.path);
  } catch {
    /* 项目列表读不到——只放行对话缩略图根 */
  }
  return roots;
}

/** 在 app.whenReady() 之后调用，注册 oru-toolimg:// 协议的请求 handler */
export function registerToolImageProtocol(): void {
  protocol.handle('oru-toolimg', async (request) => {
    const rawPath = decodeURIComponent(new URL(request.url).pathname);
    if (!IMG_EXT.has(extname(rawPath).toLowerCase())) {
      return new Response('Forbidden', { status: 403 });
    }
    // realpath 后再判，挡 .. 穿越与 symlink 逃逸（目标不存在则直接 404）
    let real: string;
    try {
      real = await realpath(rawPath);
    } catch {
      return new Response('Not Found', { status: 404 });
    }
    const roots = await allowedRoots();
    if (!roots.some((r) => isWithin(real, r))) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await readFile(real);
      return new Response(data, {
        headers: { 'Content-Type': MIME[extname(real).toLowerCase()] ?? 'image/png' },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
