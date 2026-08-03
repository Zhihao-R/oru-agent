/**
 * oru-avatar:// 自定义协议 handler
 *
 * 解决问题：Electron 默认 webSecurity 不允许 renderer 通过 file:// 加载本地图片。
 * 注册自定义 scheme，在 main 进程拦截请求，校验路径安全后从磁盘读取并返回。
 *
 * URL 格式：oru-avatar:///<absolute-path-to-png>
 *   例：oru-avatar:///Users/oru/.oru/users/local-user/avatars/twin-1234.png
 *
 * 安全约束：只允许 USERS_DIR 下的 /avatars/ 子目录，否则返回 403。
 */
import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { normalize } from 'node:path';
import { USERS_DIR } from '../runtime/paths';

/** 在 app.whenReady() 之后调用，注册 oru-avatar:// 协议的请求 handler */
export function registerAvatarProtocol(): void {
  protocol.handle('oru-avatar', async (request) => {
    // 从 URL 里取出绝对路径，decodeURIComponent 还原 encodeURI 编码的字符
    const rawPath = new URL(request.url).pathname;
    const filePath = normalize(decodeURIComponent(rawPath));

    // 安全检查：路径必须在 USERS_DIR 下，且包含 /avatars/ 子目录
    const normalizedUsersDir = normalize(USERS_DIR);
    const isUnderUsersDir = filePath.startsWith(normalizedUsersDir + '/') || filePath.startsWith(normalizedUsersDir + '\\');
    const isInAvatarsDir = filePath.includes('/avatars/') || filePath.includes('\\avatars\\');

    if (!isUnderUsersDir || !isInAvatarsDir) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await readFile(filePath);
      return new Response(data, {
        headers: { 'Content-Type': 'image/png' },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}
