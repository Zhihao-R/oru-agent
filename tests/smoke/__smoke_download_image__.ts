/**
 * __smoke_download_image__ —— 验 download_image 的目标行为本身（任务 3 §8）。
 *
 * 覆盖：
 *  - 落地：mock 返回 PNG 字节的 url → 文件落在 deck 的 images/、回传相对路径 images/x.png、magic 通过。
 *  - 串名防护（决策 5）：同名连下两次 → 第二次落盘名去重为 x-2.png 且**回传的相对路径就是 images/x-2.png**。
 *  - 类型校验：返回 HTML（伪装 content-type=image/png）→ magic bytes 挡下、不落盘。
 *  - SSRF：169.254.169.254（云元数据）→ checkUrlSafe 挡下、不落盘。
 */
import './__smoke_isolate__';
import zlib from 'node:zlib';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '@shared/agent/backend';
import { makeDownloadImageTool } from '../../electron/main/agent/agentTools/downloadImage';
import { addProject } from '../../electron/main/projects/store';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

/** 生成一张 2×2 纯色 PNG 的字节 */
function solidPng(): Buffer {
  const w = 2;
  const h = 2;
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
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const p = y * (w * 3 + 1) + 1 + x * 3;
      raw[p] = 80;
      raw[p + 1] = 160;
      raw[p + 2] = 240;
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main(): Promise<void> {
  console.log('=== download_image smoke ===');
  const PNG = solidPng();

  // mock global.fetch：用不会解析到私有 IP 的假主机名（DNS 失败不阻断 SSRF，真 fetch 永不发生）。
  // /img.png 真 PNG；/fake.png content-type 谎称 image 实则 HTML（验 magic-byte 守卫）。
  const base = 'https://imgs.test';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/img.png')) {
      return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url.endsWith('/fake.png')) {
      return new Response('<!doctype html><html>not an image</html>', {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    }
    if (url.endsWith('/redir.png')) {
      // 302 跳到云元数据端点——验 SSRF 逐跳校验挡住 redirect 落点（不能用 redirect:'follow' 绕过）
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }
    return new Response('nope', { status: 404 });
  }) as typeof globalThis.fetch;

  // 注册一个临时项目根 → dest 落在其下，过 assertWritableSandbox
  const projectRoot = await fs.mkdtemp(join(tmpdir(), 'dlimg-proj-'));
  const project = await addProject(projectRoot);
  const imagesDir = join(project.path, 'images');

  const ctx: ToolContext = {
    conversationId: 'cnv-dl',
    agentId: 'agent-dl',
    ownerId: 'local-user',
    usage: 'subagentCoder',
    approvalMode: 'work',
    abortSignal: new AbortController().signal,
  };
  const tool = makeDownloadImageTool();

  try {
    // 1. 落地
    const r1 = await tool.execute({ url: `${base}/img.png`, dest: join(imagesDir, 'hero.jpg') }, ctx);
    assert(!r1.isError, `落地不应报错：${r1.text}`);
    assert(r1.text.includes('images/hero.jpg'), `应回传 images/hero.jpg，得到：${r1.text}`);
    const heroBytes = await fs.readFile(join(imagesDir, 'hero.jpg'));
    assert(heroBytes[0] === 0x89 && heroBytes[1] === 0x50, '落地文件应是 PNG magic bytes');
    console.log('✓ 落地：文件在 images/，回传相对路径正确，magic 通过');

    // 2. 串名去重
    const r2 = await tool.execute({ url: `${base}/img.png`, dest: join(imagesDir, 'hero.jpg') }, ctx);
    assert(!r2.isError, `第二次不应报错：${r2.text}`);
    assert(r2.text.includes('images/hero-2.jpg'), `重名应回传 images/hero-2.jpg，得到：${r2.text}`);
    const dedupExists = await fs.access(join(imagesDir, 'hero-2.jpg')).then(() => true).catch(() => false);
    assert(dedupExists, 'hero-2.jpg 应落盘');
    assert((r2.structured as { relPath?: string })?.relPath === 'images/hero-2.jpg', 'structured.relPath 应为 images/hero-2.jpg');
    console.log('✓ 串名防护：第二次去重为 hero-2.jpg，回传路径一致');

    // 3. 类型校验：HTML 伪装 image/png → magic 挡下
    const r3 = await tool.execute({ url: `${base}/fake.png`, dest: join(imagesDir, 'x.png') }, ctx);
    assert(r3.isError, '伪装图片应被挡下');
    const xExists = await fs.access(join(imagesDir, 'x.png')).then(() => true).catch(() => false);
    assert(!xExists, 'x.png 不应落盘');
    console.log('✓ 类型校验：HTML 伪装被 magic bytes 挡下，不落盘');

    // 4. SSRF
    const r4 = await tool.execute({ url: 'http://169.254.169.254/meta.png', dest: join(imagesDir, 'y.png') }, ctx);
    assert(r4.isError, '云元数据端点应被 SSRF 挡下');
    const yExists = await fs.access(join(imagesDir, 'y.png')).then(() => true).catch(() => false);
    assert(!yExists, 'y.png 不应落盘');
    console.log('✓ SSRF：169.254.169.254 被挡下，不落盘');

    // 5. SSRF via redirect：公网 url 302 跳私有 IP → 逐跳校验在 redirect 落点挡下
    const r5 = await tool.execute({ url: `${base}/redir.png`, dest: join(imagesDir, 'z.png') }, ctx);
    assert(r5.isError, '302 跳私有 IP 应被逐跳 SSRF 挡下（不能被 redirect:follow 绕过）');
    const zExists = await fs.access(join(imagesDir, 'z.png')).then(() => true).catch(() => false);
    assert(!zExists, 'z.png 不应落盘');
    console.log('✓ SSRF-redirect：302→169.254.169.254 在 redirect 落点被挡下');

    // 6. SSRF IPv6 字面量：带方括号的回环/IPv4-mapped 不能绕过（第二轮 review 抓到的洞）
    const v6urls = [
      'http://[::1]:8080/secret.png', // 回环
      'http://[::ffff:7f00:1]/x.png', // IPv4-mapped 127.0.0.1（hex 形态）
      'http://[::ffff:169.254.169.254]/meta.png', // IPv4-mapped 云元数据
    ];
    for (const u of v6urls) {
      const r = await tool.execute({ url: u, dest: join(imagesDir, 'v6.png') }, ctx);
      assert(r.isError, `IPv6 绕过应被挡下：${u}`);
    }
    const v6Exists = await fs.access(join(imagesDir, 'v6.png')).then(() => true).catch(() => false);
    assert(!v6Exists, 'IPv6 绕过不应落盘');
    console.log('✓ SSRF-IPv6：[::1] / [::ffff:127.0.0.1] / [::ffff:169.254.169.254] 全被挡下');

    console.log('\n[ALL DOWNLOAD_IMAGE SMOKES PASSED]');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
