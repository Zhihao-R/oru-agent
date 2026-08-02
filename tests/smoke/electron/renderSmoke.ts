/**
 * Electron 端 smoke：验证渲染原语 renderHtmlToImage 本身（需要真实 BrowserWindow，
 * 故不能在 tsx/Node 的 smoke runner 里跑——由 bootstrap.mjs 在 electron 进程内调）。
 *
 * 覆盖技术设计 §8：
 *  - roundtrip：渲一段已知 HTML → 拿回 PNG → 非空、尺寸归一到 viewport、非空白、单屏 hasMore=false
 *  - long_page_scroll：渲约 3 屏长页 → 首屏 hasMore=true & contentHeight≈3×viewport；scroll 后内容不同
 *  - timeout：永不 settle 的 HTML → 到点超时报错 + 窗口销毁（无孤儿）
 *  - full_bleed_no_truncation：四角铺满色块的整版页 → 四角都截到（回归：小屏窗口被 OS 钳时，
 *    旧 capturePage 只截可视区把右/下切掉，CDP captureBeyondViewport 不会）
 */
import { BrowserWindow, nativeImage, screen } from 'electron';
import { tmpdir } from 'node:os';
import { renderHtmlToImage, RenderError } from '../../../electron/main/render/htmlRenderer';

const ONE_SCREEN = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  .s{width:1920px;height:1080px;display:flex;align-items:center;justify-content:center;
     font:700 120px system-ui,sans-serif;color:#fff}
</style></head><body><div class="s" style="background:#ff0000">RED ONE</div></body></html>`;

const THREE_SCREENS = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  .s{width:1920px;height:1080px;display:flex;align-items:center;justify-content:center;
     font:700 120px system-ui,sans-serif;color:#fff}
</style></head><body>
  <div class="s" style="background:#ff0000">SCREEN ONE</div>
  <div class="s" style="background:#00aa00">SCREEN TWO</div>
  <div class="s" style="background:#0000ff">SCREEN THREE</div>
</body></html>`;

// 同步死循环脚本：卡死渲染进程主线程 → load/字体/测量任一步都会先撞上总超时，用来验超时与无孤儿窗口
const NEVER_SETTLE = `<!doctype html><html><head><script>while(true){}</script></head><body>x</body></html>`;

// 四角各打 80px 色块的整版页：用 3000×2000 画布——比任何笔记本工作区都大、窗口必被 OS 钳小，
// 从而**确定性**复现旧 bug 的触发条件（不依赖跑测机屏幕大小）。旧 capturePage 只截可视窗口区，
// 右/下色块整块丢失、且老代码在大屏上侥幸不钳就测不出；CDP captureBeyondViewport 与窗口尺寸解耦，
// 四角必全中。配 FULL_BLEED_VIEWPORT 使用。
const FULL_BLEED_VIEWPORT = { width: 3000, height: 2000 };
const FULL_BLEED = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#101820}
  .b{position:absolute;width:80px;height:80px}
</style></head><body>
  <div class="b" style="left:0;top:0;background:#ff0000"></div>
  <div class="b" style="right:0;top:0;background:#00ff00"></div>
  <div class="b" style="left:0;bottom:0;background:#0000ff"></div>
  <div class="b" style="right:0;bottom:0;background:#ffff00"></div>
</body></html>`;

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

/** 解码 PNG base64，取中心点 RGB（判断不同屏内容不同） */
function centerRgb(pngBase64: string): { r: number; g: number; b: number; w: number; h: number } {
  const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'));
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i], w: width, h: height };
}

/** 解码 PNG base64，取指定坐标 RGB（验四角是否截到） */
function rgbAt(pngBase64: string, x: number, y: number): { r: number; g: number; b: number } {
  const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'));
  const { width } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const i = (y * width + x) * 4;
  return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i] };
}

export async function runRenderSmoke(): Promise<void> {
  const baseDir = tmpdir();

  // ── 1. roundtrip ──
  {
    const { pngBase64, meta } = await renderHtmlToImage({
      source: { kind: 'inline', html: ONE_SCREEN, baseDir },
    });
    assert(pngBase64.length > 100, 'roundtrip: PNG 应非空');
    assert(meta.width === 1920 && meta.height === 1080, `roundtrip: meta 视口应 1920×1080，得到 ${meta.width}×${meta.height}`);
    assert(meta.isBlank === false, 'roundtrip: 红屏不应判为空白');
    assert(meta.hasMore === false, 'roundtrip: 单屏页 hasMore 应为 false');
    const c = centerRgb(pngBase64);
    assert(c.w === 1920 && c.h === 1080, `roundtrip: PNG 尺寸应归一到 1920×1080，得到 ${c.w}×${c.h}`);
    assert(c.r > 200 && c.g < 80 && c.b < 80, `roundtrip: 中心应为红，得到 rgb(${c.r},${c.g},${c.b})`);
    console.log(`✓ roundtrip：PNG ${c.w}×${c.h}，中心红 rgb(${c.r},${c.g},${c.b})，contentHeight=${meta.contentHeight}`);
  }

  // ── 2. long_page_scroll ──
  {
    const first = await renderHtmlToImage({ source: { kind: 'inline', html: THREE_SCREENS, baseDir }, scrollY: 0 });
    assert(first.meta.hasMore === true, 'long: 首屏 hasMore 应为 true');
    assert(
      Math.abs(first.meta.contentHeight - 3240) <= 4,
      `long: contentHeight 应≈3240，得到 ${first.meta.contentHeight}`,
    );
    const second = await renderHtmlToImage({ source: { kind: 'inline', html: THREE_SCREENS, baseDir }, scrollY: 1080 });
    // 采背景色判别屏：取上方 (960,150)，避开正中居中的白字——CDP 在 dpr=1 下原生渲染锐利，
    // 正中心像素会压到白字笔画上（旧 capturePage 走 2x 超采样再缩、恰采到底色，属采样巧合）。
    const c1 = rgbAt(first.pngBase64, 960, 150);
    const c2 = rgbAt(second.pngBase64, 960, 150);
    assert(c1.r > 200 && c1.g < 80, `long: 首屏应红，得到 rgb(${c1.r},${c1.g},${c1.b})`);
    assert(c2.g > 120 && c2.r < 120, `long: 第二屏应绿，得到 rgb(${c2.r},${c2.g},${c2.b})`);
    assert(first.pngBase64 !== second.pngBase64, 'long: 两屏截图应不同');
    console.log(`✓ long_page_scroll：首屏红→第二屏绿，contentHeight=${first.meta.contentHeight}，hasMore 正确`);
  }

  // ── 3. timeout + 无孤儿窗口 ──
  {
    const before = BrowserWindow.getAllWindows().length;
    let threw: unknown;
    try {
      await renderHtmlToImage({ source: { kind: 'inline', html: NEVER_SETTLE, baseDir }, timeoutMs: 1500 });
    } catch (e) {
      threw = e;
    }
    assert(threw instanceof RenderError, 'timeout: 应抛 RenderError');
    assert(/超时/.test((threw as Error).message), `timeout: 错误文案应含"超时"，得到 ${(threw as Error).message}`);
    const after = BrowserWindow.getAllWindows().length;
    assert(after === before, `timeout: 不应残留孤儿窗口（before=${before} after=${after}）`);
    console.log(`✓ timeout：到点抛 RenderError「${(threw as Error).message}」，窗口已销毁（无孤儿）`);
  }

  // ── 4. full_bleed_no_truncation（截断回归）──
  {
    const { width: vw, height: vh } = FULL_BLEED_VIEWPORT;
    // 前提自证：画布必须大于工作区，才真的触发"窗口被钳"——否则这条测不到目标 bug
    const wa = screen.getPrimaryDisplay().workAreaSize;
    assert(vw > wa.width || vh > wa.height, `full_bleed: 画布 ${vw}×${vh} 须大于工作区 ${wa.width}×${wa.height} 才能触发窗口被钳`);

    const { pngBase64, meta } = await renderHtmlToImage({
      source: { kind: 'inline', html: FULL_BLEED, baseDir },
      viewport: FULL_BLEED_VIEWPORT,
    });
    assert(meta.width === vw && meta.height === vh, `full_bleed: 截图应满画布 ${vw}×${vh}，得到 ${meta.width}×${meta.height}`);
    // 探在每个 80px 色块内部（避开抗锯齿边缘），四角各取一点
    const corners = {
      '左上': rgbAt(pngBase64, 40, 40),
      '右上': rgbAt(pngBase64, vw - 40, 40),
      '左下': rgbAt(pngBase64, 40, vh - 40),
      '右下': rgbAt(pngBase64, vw - 40, vh - 40),
    };
    const isBg = (c: { r: number; g: number; b: number }) => c.r < 60 && c.g < 60 && c.b < 80;
    for (const [name, p] of Object.entries(corners)) {
      assert(!isBg(p), `full_bleed: ${name}角应是色块、不应是背景（截断）——得到 rgb(${p.r},${p.g},${p.b})`);
    }
    assert(corners['右上'].g > 150 && corners['右上'].r < 120, `full_bleed: 右上应绿，得到 rgb(${corners['右上'].r},${corners['右上'].g},${corners['右上'].b})`);
    assert(corners['右下'].r > 150 && corners['右下'].g > 150, `full_bleed: 右下应黄，得到 rgb(${corners['右下'].r},${corners['右下'].g},${corners['右下'].b})`);
    console.log(`✓ full_bleed_no_truncation：${vw}×${vh} 画布在 ${wa.width}×${wa.height} 屏被钳，四角色块仍全部截到（右/下未被切）`);
  }

  console.log('\n[ALL RENDER SMOKES PASSED]');
}
