/**
 * G105 read_file 兼读图（多模态）——read_file 遇图片路径改走图像回执通道。
 *
 * 覆盖：
 *  ① 图片路径（.png/.jpg/.webp…）→ 结果带 images（PNG base64），文字含尺寸；走 decodeThumbnails
 *     归一降采样（与 image_search/view_slide 同一回执通道，各后端按既有设计分流，本工具不碰后端）。
 *  ② 解码失败（坏字节/不支持格式）→ isError，不静默返回空图。
 *  ③ 回归：文本文件仍走原文本读取路径，不带 images、不碰解码器。
 *
 * pathSandbox 与 decodeThumbnails 被 mock：前者放行任意路径（沙箱本身另有测试），后者避开 Electron 离屏。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeToolContext } from '../helpers/toolContext';

// 沙箱放行：assertReadableSandbox 变 no-op，SandboxError 保留（本工具沙箱另有专测）
vi.mock('../../electron/main/agent/agentTools/pathSandbox', async (orig) => {
  const actual = await orig<typeof import('../../electron/main/agent/agentTools/pathSandbox')>();
  return { ...actual, assertReadableSandbox: vi.fn(async () => {}) };
});

// 离屏解码器 mock：默认解出一张 8×8 PNG；坏图（bad.png）返回 null
const DECODED_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
vi.mock('../../electron/main/render/imageDecoder', () => ({
  decodeThumbnails: vi.fn(async (inputs: Array<{ bytes: Uint8Array; mime: string }>) =>
    inputs.map(() =>
      decodeShouldFail ? null : { pngBase64: DECODED_B64, width: 8, height: 8 },
    ),
  ),
  // 归一宽度上限现在由 imageDecoder 单点导出（read_file 与外部 MCP 图共用），mock 要一并给出
  IMAGE_VIEW_MAX_WIDTH: 1568,
}));

let decodeShouldFail = false;

import { makeReadFileTool } from '../../electron/main/agent/agentTools/readFile';

const ctx = makeToolContext({ conversationId: 'c1', agentId: 'a1', ownerId: 'o1' });

let dir: string;
afterEach(() => {
  decodeShouldFail = false;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('G105 read_file 读图', () => {
  it('图片路径 → 返回 PNG images + 尺寸文字', async () => {
    dir = mkdtempSync(join(tmpdir(), 'readimg-'));
    const p = join(dir, 'shot.png');
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // 任意字节（解码器已 mock）

    const res = await makeReadFileTool().execute({ path: p }, ctx);

    expect(res.isError).toBeFalsy();
    expect(res.images).toEqual([{ base64: DECODED_B64, mediaType: 'image/png' }]);
    expect(res.text).toContain('8×8');
  });

  it('jpg/webp 也识别为图片', async () => {
    dir = mkdtempSync(join(tmpdir(), 'readimg-'));
    const p = join(dir, 'photo.webp');
    writeFileSync(p, Buffer.from([1, 2, 3]));

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.images?.length).toBe(1);
  });

  it('解码失败 → isError，不返回空图', async () => {
    decodeShouldFail = true;
    dir = mkdtempSync(join(tmpdir(), 'readimg-'));
    const p = join(dir, 'bad.png');
    writeFileSync(p, Buffer.from([0]));

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.isError).toBe(true);
    expect(res.images).toBeUndefined();
  });

  it('回归：文本文件仍走文本路径，不带 images', async () => {
    dir = mkdtempSync(join(tmpdir(), 'readimg-'));
    const p = join(dir, 'note.txt');
    writeFileSync(p, 'hello\nworld');

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.images).toBeUndefined();
    expect(res.text).toContain('hello');
  });
});
