/**
 * saveAttachments 超限图自动压缩（S34 · G25，锚 conversation-flow.html#Ingest）。
 *
 * 目标态：撤「>5MB 直接拒收」，超模型字节上限的图缩放 + JPEG 重编码压到限制内后落盘；未超限的
 * 原样保真（不无谓重编码）。离屏压缩器（compressImagesToLimit，需 Electron）被 mock——本测试只验
 * saveAttachments 的分流与落盘形态，真离屏压缩由 playtest 覆盖。
 *
 * ORU_DIR 必须在 paths 加载前设好。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORU_DIR = mkdtempSync(join(tmpdir(), 'oru-test-attcompress-'));

const { compressMock } = vi.hoisted(() => ({
  compressMock: vi.fn<(typeof import('../../electron/main/render/imageDecoder'))['compressImagesToLimit']>(),
}));
vi.mock('../../electron/main/render/imageDecoder', () => ({ compressImagesToLimit: compressMock }));
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'owner-1',
}));

import {
  saveAttachments,
  MAX_BYTES_PER_IMAGE,
  AttachmentError,
} from '../../electron/main/conversations/attachments';
import { readAttachmentBase64 } from '../../electron/main/conversations/attachments';

// 真 PNG（1×1）与真 JPEG magic 头——detectMime 要过
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** 造一张「声明为 PNG、字节 > 5MB」的图：真 PNG 头 + padding（detectMime 只看头 8 字节）。 */
function hugePng(): Buffer {
  return Buffer.concat([PNG_1X1, Buffer.alloc(MAX_BYTES_PER_IMAGE, 0)]);
}
/** 压缩产物：一段带 JPEG magic 头的小字节。 */
const SMALL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

beforeEach(() => {
  vi.clearAllMocks();
  compressMock.mockResolvedValue([{ bytes: SMALL_JPEG, width: 800, height: 600 }]);
});

function item(buf: Buffer, mediaType: 'image/png' | 'image/jpeg' = 'image/png') {
  return { base64: buf.toString('base64'), mediaType, filename: 'x.png', bytes: buf.length };
}

describe('saveAttachments 超限压缩（G25）', () => {
  it('超 5MB 真图 → 压缩落盘，产物为 image/jpeg（不再拒收）', async () => {
    const out = await saveAttachments('a', 'conv-c1', 'msg1', [item(hugePng())]);

    expect(compressMock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0].mediaType).toBe('image/jpeg');
    expect(out[0].bytes).toBe(SMALL_JPEG.length);
    expect(out[0].relPath.endsWith('.jpg')).toBe(true);
    // 落盘的确是压缩后的字节
    const b64 = await readAttachmentBase64('a', 'conv-c1', out[0]);
    expect(Buffer.from(b64, 'base64')).toEqual(SMALL_JPEG);
  });

  it('未超限图 → 不压缩、原样保真', async () => {
    const out = await saveAttachments('a', 'conv-c2', 'msg2', [item(PNG_1X1)]);
    expect(compressMock).not.toHaveBeenCalled();
    expect(out[0].mediaType).toBe('image/png');
    const b64 = await readAttachmentBase64('a', 'conv-c2', out[0]);
    expect(Buffer.from(b64, 'base64')).toEqual(PNG_1X1);
  });

  it('超限但压不动（压缩器返回 null）→ 回落拒收 TOO_LARGE', async () => {
    compressMock.mockResolvedValueOnce([null]);
    await expect(saveAttachments('a', 'conv-c3', 'msg3', [item(hugePng())])).rejects.toBeInstanceOf(
      AttachmentError,
    );
  });

  it('混批：只压超限的那张，未超限的原样（compressMock 只收到 1 张）', async () => {
    const out = await saveAttachments('a', 'conv-c4', 'msg4', [item(PNG_1X1), item(hugePng())]);
    expect(compressMock).toHaveBeenCalledTimes(1);
    expect(compressMock.mock.calls[0][0]).toHaveLength(1); // 只传了超限那张
    expect(out[0].mediaType).toBe('image/png'); // 第一张原样
    expect(out[1].mediaType).toBe('image/jpeg'); // 第二张压缩
  });
});
