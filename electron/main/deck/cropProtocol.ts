/**
 * oru-crop:// 自定义协议 handler
 *
 * 解决问题：Electron 默认 webSecurity 不允许 renderer 主窗口通过 file:// 加载本地图片
 * （webview 是独立 file:// 上下文不受此限，但 AnnotPane 在主窗口里，<img src="file://…"> 裂图）。
 * 注册自定义 scheme，在 main 进程拦截、校验路径后从磁盘读字节返回——与 oru-avatar:// 同套路。
 *
 * URL 格式：oru-crop://local/<absolute-path-to-crop.png>
 *   例：oru-crop://local/Users/oru/projects/my-deck/.annotations/crops/ann_xxx.png
 *
 * 安全约束：路径必须落在某个制品的 `.annotations/crops/` 子目录下、且是 .png——
 * 框选截图就这一种，足够收窄，不放开任意文件读。
 */
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { normalize } from 'node:path';

/** 在 app.whenReady() 之后调用，注册 oru-crop:// 协议的请求 handler */
export function registerCropProtocol(): void {
  protocol.handle('oru-crop', async (request) => {
    const rawPath = new URL(request.url).pathname;
    const filePath = normalize(decodeURIComponent(rawPath));

    const inCropsDir = filePath.includes('/.annotations/crops/') || filePath.includes('\\.annotations\\crops\\');
    if (!inCropsDir || !filePath.toLowerCase().endsWith('.png')) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await readFile(filePath);
      return new Response(data, { headers: { 'Content-Type': 'image/png' } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
