/**
 * Electron smoke：image_search 的"睁眼挑输入成形"+"N 路部分失败"（任务 3 §8，决策 2/3）。
 *
 * 直接验 search/imageThumb.fetchThumbnails（真 canvas 归一化，需 BrowserWindow，故走 electron）：
 *  - 3 个候选里 1 个缩略图 URL 拉取失败 → 返回存活的 2 张、保持原候选顺序（跳过坏的）、
 *    每张产出非空 ≤512px PNG —— 这正是喂进模型视野的那批，文字清单据同一存活列表拼装故同序。
 *  - 3 个全失败 → 存活 0（调用方据此 isError）。
 *  - 顺带保留 WebP 解码实证（spike 结论固化）：/tmp/spike_sample.webp 若在则验，缺则跳过。
 *
 * 跑法：node_modules/.bin/electron tests/smoke/electron/imageThumbSmokeBootstrap.mjs
 */
import zlib from 'node:zlib';
import { promises as fs } from 'node:fs';
import { fetchThumbnails } from '../../../electron/main/search/imageThumb';
import type { ImageResultItem } from '../../../electron/main/search/types';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

/** 生成一张 w×h 纯色 PNG 字节 */
function solidPng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const p = y * (w * 3 + 1) + 1 + x * 3;
      raw[p] = 200;
      raw[p + 1] = 60;
      raw[p + 2] = 60;
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const item = (url: string): ImageResultItem => ({ thumbnailUrl: url, contentUrl: url });

export async function runImageThumbSmoke(): Promise<void> {
  console.log('=== image_search thumbnails smoke（feed-thumbs + 部分失败）===');
  const BIG = solidPng(800, 500); // > 512 宽，验降采样

  // mock fetch：a/b 返回 PNG，dead → 404
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/dead.png')) return new Response('x', { status: 404 });
    return new Response(BIG, { status: 200, headers: { 'Content-Type': 'image/png' } });
  }) as typeof globalThis.fetch;

  try {
    // 1. 部分失败：3 个候选，中间那个 404 → 存活 2，顺序保留（a, b），跳过 dead
    const survived = await fetchThumbnails(
      [item('https://t.test/a.png'), item('https://t.test/dead.png'), item('https://t.test/b.png')],
      { count: 6, signal: new AbortController().signal },
    );
    assert(survived.length === 2, `应存活 2 张，得到 ${survived.length}`);
    assert(survived[0].item.contentUrl === 'https://t.test/a.png', '存活[0] 应为 a（顺序保留）');
    assert(survived[1].item.contentUrl === 'https://t.test/b.png', '存活[1] 应为 b（跳过 dead）');
    for (const s of survived) {
      assert(s.pngBase64.length > 100, '缩略图 PNG 应非空');
      assert(s.width <= 512, `缩略图宽应 ≤512，得到 ${s.width}`);
    }
    console.log(`✓ 部分失败：3 候选挂 1 → 存活 2，顺序保留，降采样到 ${survived[0].width}px`);

    // 2. 全失败 → 0
    const allDead = await fetchThumbnails(
      [item('https://t.test/dead.png'), item('https://t.test/dead.png')],
      { count: 6, signal: new AbortController().signal },
    );
    assert(allDead.length === 0, `全坏链应存活 0，得到 ${allDead.length}`);
    console.log('✓ 全失败：存活 0（调用方据此报错让模型换 query）');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 3. WebP 解码实证（spike 结论固化）——样图在则验
  const webpPath = '/tmp/spike_sample.webp';
  const exists = await fs.access(webpPath).then(() => true).catch(() => false);
  if (exists) {
    const { decodeThumbnails } = await import('../../../electron/main/render/imageDecoder');
    const bytes = await fs.readFile(webpPath);
    const [d] = await decodeThumbnails([{ bytes, mime: 'image/webp' }], 512);
    assert(d && d.pngBase64.length > 100, 'WebP 应能经 canvas 解码成非空 PNG');
    console.log(`✓ WebP 解码：→ ${d!.width}×${d!.height} PNG（canvas 统一路径，nativeImage 解不了）`);
  } else {
    console.log('· WebP 实证跳过（无 /tmp/spike_sample.webp）');
  }

  console.log('\n[IMAGE THUMB SMOKE PASSED]');
}
