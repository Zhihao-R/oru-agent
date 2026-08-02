/**
 * oru-conv-img:// 路径沙箱——resolveConvImageRequest 是协议 handler 读盘前的最后一道闸。
 * URL 来自渲染端、可被任意构造（attacker 场景），必须钉死在 USERS_DIR 下
 * conversations 的 <convId>-images/ 目录、且扩展名在图片白名单内。
 */
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

// imageProtocol 顶层 import { protocol } from 'electron'——单测只用纯函数，把 electron 模块挡掉
vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }));

import { USERS_DIR } from '../../electron/main/runtime/paths';
import { resolveConvImageRequest } from '../../electron/main/conversations/imageProtocol';

const IMG = join(USERS_DIR, 'o1', 'conversations', 'a1', 'c1-images', 'm1-1.png');

function url(p: string): string {
  return `oru-conv-img://local${encodeURI(p)}`;
}

describe('resolveConvImageRequest', () => {
  it('合法路径：还原绝对路径 + 按扩展名给 Content-Type（路径带空格也走 encodeURI 往返）', () => {
    expect(resolveConvImageRequest(url(IMG))).toEqual({ path: IMG, contentType: 'image/png' });
    const spaced = join(USERS_DIR, 'o 1', 'conversations', 'a1', 'c1-images', 'm1-1.webp');
    expect(resolveConvImageRequest(url(spaced))).toEqual({
      path: spaced,
      contentType: 'image/webp',
    });
  });

  it('../ 穿越：折叠后落点不合法即拒绝（逃出 images 目录 / 逃出 USERS_DIR）', () => {
    // 同目录层级逃到 jsonl（落盘对话原文）
    expect(
      resolveConvImageRequest(url(join(IMG, '..', '..', 'c1.jsonl'))),
    ).toBeNull();
    // 一路穿出 USERS_DIR 读任意文件（伪装 .png 后缀也不行）
    expect(
      resolveConvImageRequest(
        url(join(IMG, '..', '..', '..', '..', '..', '..', '..', 'etc', 'passwd.png')),
      ),
    ).toBeNull();
  });

  it('目录不对就拒绝：USERS_DIR 外 / 不在 conversations 下 / 不是 -images 目录', () => {
    expect(resolveConvImageRequest(url('/tmp/conversations/a1/c1-images/x.png'))).toBeNull();
    expect(
      resolveConvImageRequest(url(join(USERS_DIR, 'o1', 'avatars', 'c1-images', 'x.png'))),
    ).toBeNull();
    expect(
      resolveConvImageRequest(url(join(USERS_DIR, 'o1', 'conversations', 'a1', 'x.png'))),
    ).toBeNull();
  });

  it('结构钉死五段：旁系目录里伪装的 *-images/（如 tool-cache 下工具自建）不放行', () => {
    // <convId>-tool-cache 是工具结果可写的目录——里面再建 x-images/ 也凑不齐五段结构
    expect(
      resolveConvImageRequest(
        url(join(USERS_DIR, 'o1', 'conversations', 'a1', 'c1-tool-cache', 'x-images', 'evil.png')),
      ),
    ).toBeNull();
  });

  it('扩展名不在图片白名单 / URL 不是合法 URL / 畸形 % 序列 → 拒绝且不 throw', () => {
    expect(
      resolveConvImageRequest(url(join(USERS_DIR, 'o1', 'conversations', 'a1', 'c1-images', 'x.jsonl'))),
    ).toBeNull();
    expect(resolveConvImageRequest('not a url')).toBeNull();
    // decodeURIComponent 对 %zz 抛 URIError——windowOpenHandler 同步调用，这里必须接住
    expect(resolveConvImageRequest('oru-conv-img://local/%zz.png')).toBeNull();
  });
});
