/**
 * Electron 端 fidelity spike / __smoke_deck_contact_sheet__（任务 6 头号风险，决策 1）。
 *
 * 拿一份忠实复现 guizang-ppt-skill 格式的 deck（多 section.slide + "只显当前页"隐藏机制 +
 * vw/vh + images/ 相对图 + web font），验"摘单页 + 可见性归一化 → 独立渲染"：
 *  ① 每页渲得出全分辨率图（1920×1080、非空白）——尤其**非 active 的被隐藏页**（opacity:0 +
 *     visibility:hidden + position:absolute）经归一化后必须可见，不被吃成空白（fidelity 核心）；
 *  ② vw/vh 版式按真实 1920×1080 视口算（不失真）——以 page3 的 vw 定位色块为锚验；
 *  ③ images/ 相对图正确解析加载（inline 源写进 deckPath，相对路径照常）；
 *  ④ composeGrid 合成出非空网格图（含页码徽标）。
 *
 * 不通就退 iframe 方案（决策 1 的退路）。需真实 BrowserWindow，由 contactSheetBootstrap.mjs 在
 * electron 进程内调（同 renderSmoke）。
 */
import { nativeImage } from 'electron';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildContactSheet, renderSinglePage } from '../../../electron/main/deck/contactSheet';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

/** 解码 PNG base64，取相对坐标 (xFrac,yFrac) 的 RGB + 尺寸 */
function sampleRgb(
  pngBase64: string,
  xFrac: number,
  yFrac: number,
): { r: number; g: number; b: number; w: number; h: number } {
  const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'));
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const x = Math.min(width - 1, Math.max(0, Math.floor(xFrac * width)));
  const y = Math.min(height - 1, Math.max(0, Math.floor(yFrac * height)));
  const i = (y * width + x) * 4;
  return { r: bmp[i + 2], g: bmp[i + 1], b: bmp[i], w: width, h: height };
}

/** 判一张 PNG 是否接近全白（被隐藏机制吃成空白的典型表现） */
function isNearWhite(pngBase64: string): boolean {
  const img = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'));
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  let nonWhite = 0;
  let sampled = 0;
  for (let gy = 0; gy < 16; gy += 1) {
    for (let gx = 0; gx < 16; gx += 1) {
      const x = Math.floor((gx + 0.5) * (width / 16));
      const y = Math.floor((gy + 0.5) * (height / 16));
      const idx = (y * width + x) * 4;
      sampled += 1;
      if (bmp[idx] < 248 || bmp[idx + 1] < 248 || bmp[idx + 2] < 248) nonWhite += 1;
    }
  }
  return nonWhite / sampled < 0.01;
}

/**
 * Fixture：忠实复现 guizang 格式。隐藏机制 = .slide 绝对定位铺满 + opacity:0 + visibility:hidden，
 * 仅 .active 可见（最难的一类：单纯 display 切换之外还叠了 visibility/opacity/绝对定位）。
 * page1 红 / page2 蓝（默认被隐藏，验归一化）/ page3 绿 + vw 定位的色块 + images/ 相对图。
 */
const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; font-family: 'Fraunces', serif; }
  .slide {
    position: absolute; inset: 0;
    width: 100vw; height: 100vh;
    display: flex; align-items: center; justify-content: center;
    opacity: 0; visibility: hidden;            /* 默认隐藏：只显 .active */
    transform: translateX(40px);
    color: #fff; font-size: 6vw; font-weight: 700;
  }
  .slide.active { opacity: 1; visibility: visible; transform: none; }
  #s1 { background: #cc0000; }
  #s2 { background: #0000cc; }
  #s3 { background: #008800; }
  /* page3 vw 定位的锚色块：放在右下区域（中心保持纯绿，便于采样判 vw/vh 没失真） */
  .vw-anchor { position: absolute; right: 8vw; bottom: 8vh; width: 16vw; height: 16vh; background: #ff00ff; }
  /* images/ 相对图：放左上角 */
  .hero { position: absolute; left: 6vw; top: 6vh; width: 12vw; height: 12vw; object-fit: cover; }
</style></head>
<body class="deck">
  <section class="slide active" id="s1">PAGE ONE</section>
  <section class="slide" id="s2">PAGE TWO</section>
  <section class="slide" id="s3">
    <img class="hero" src="images/hero.png" alt="hero">
    <div class="vw-anchor"></div>
    PAGE THREE
  </section>
</body></html>`;

/** 造一张 120×120 纯黄 PNG 写进 images/hero.png（验相对路径解析） */
async function writeHeroImage(deckPath: string): Promise<void> {
  const W = 120;
  const H = 120;
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    buf[i * 4] = 0; // B
    buf[i * 4 + 1] = 220; // G
    buf[i * 4 + 2] = 255; // R  → 黄 (R+G)
    buf[i * 4 + 3] = 255; // A
  }
  const img = nativeImage.createFromBitmap(buf, { width: W, height: H });
  await fs.mkdir(join(deckPath, 'images'), { recursive: true });
  await fs.writeFile(join(deckPath, 'images', 'hero.png'), img.toPNG());
}

export async function runContactSheetSmoke(): Promise<void> {
  const deckPath = join(tmpdir(), `oru-cs-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(deckPath, { recursive: true });
  await fs.writeFile(join(deckPath, 'index.html'), FIXTURE_HTML, 'utf-8');
  await writeHeroImage(deckPath);

  const { sheetImages, slideImages, pageCount } = await buildContactSheet(deckPath);

  // ── 基本：3 页全分辨率图，1920×1080，1 张网格图 ──
  assert(pageCount === 3, `应拆出 3 页，得到 ${pageCount}`);
  assert(slideImages.length === 3, `应有 3 张全分辨率页图，得到 ${slideImages.length}`);
  for (let i = 0; i < 3; i += 1) {
    const s = sampleRgb(slideImages[i], 0.5, 0.5);
    assert(s.w === 1920 && s.h === 1080, `page${i + 1} 应 1920×1080，得到 ${s.w}×${s.h}`);
  }
  assert(sheetImages.length === 1, `3 页应合成 1 张网格图，得到 ${sheetImages.length}`);
  assert(sheetImages[0].length > 100, '网格图应非空');
  console.log(`✓ 拆 3 页 + 合成 1 张网格图，全分辨率页图均 1920×1080`);

  // ── fidelity ①：每页非空白（尤其 page2/page3 默认被 opacity/visibility/绝对定位隐藏） ──
  assert(!isNearWhite(slideImages[0]), 'page1（active）不应空白');
  assert(!isNearWhite(slideImages[1]), 'page2（默认隐藏）经归一化后不应空白 ← fidelity 核心');
  assert(!isNearWhite(slideImages[2]), 'page3（默认隐藏）经归一化后不应空白 ← fidelity 核心');
  console.log('✓ fidelity①：被隐藏页经可见性归一化后均渲得出（非空白）');

  // ── fidelity ②：各页背景色正确（证明 slide 铺满视口、版式没歪） ──
  // 采 (0.5,0.2) 上方背景带、不取正中：fixture 每页有居中白字，CDP 在 dpr=1 下原生渲染锐利，
  // 正中像素会压到白字笔画上（采样巧合，非渲染问题）。上方带是纯背景，验"铺满"同样成立。
  const c1 = sampleRgb(slideImages[0], 0.5, 0.2);
  assert(c1.r > 150 && c1.g < 90 && c1.b < 90, `page1 背景应红，得 rgb(${c1.r},${c1.g},${c1.b})`);
  const c2 = sampleRgb(slideImages[1], 0.5, 0.2);
  assert(c2.b > 150 && c2.r < 90 && c2.g < 90, `page2 背景应蓝，得 rgb(${c2.r},${c2.g},${c2.b})`);
  const c3 = sampleRgb(slideImages[2], 0.5, 0.2);
  assert(c3.g > 100 && c3.r < 90 && c3.b < 90, `page3 背景应绿，得 rgb(${c3.r},${c3.g},${c3.b})`);
  console.log('✓ fidelity②：各页背景色正确（slide 铺满视口、vw/vh 未失真）');

  // ── fidelity ②b：page3 vw 定位的锚色块（right:8vw bottom:8vh，16vw×16vh）应为品红 ──
  // 取右下区域一点（约 x=0.84, y=0.84，落在锚块内）
  const anchor = sampleRgb(slideImages[2], 0.84, 0.84);
  assert(
    anchor.r > 150 && anchor.b > 150 && anchor.g < 110,
    `page3 vw 锚块应品红（证 vw/vh 按 1920×1080 算），得 rgb(${anchor.r},${anchor.g},${anchor.b})`,
  );
  console.log('✓ fidelity②b：page3 vw/vh 定位色块落点正确（视口尺寸按真实 1920×1080）');

  // ── fidelity ③：images/ 相对图加载（page3 左上 hero.png 黄色块） ──
  // hero 在 left:6vw top:6vh，12vw 宽 ≈ 230px；取 x≈0.10, y≈0.12 落在图内
  const hero = sampleRgb(slideImages[2], 0.1, 0.12);
  assert(
    hero.r > 180 && hero.g > 150 && hero.b < 110,
    `page3 应加载 images/hero.png（黄），得 rgb(${hero.r},${hero.g},${hero.b})`,
  );
  console.log('✓ fidelity③：images/ 相对图正确解析加载');

  // ── view_slide 单页路径：与 buildContactSheet 同源、fresh 重渲 ──
  const { base64: single } = await renderSinglePage(deckPath, 2); // 第 3 页（0 起）
  const sc = sampleRgb(single, 0.5, 0.2); // 上方背景带，避开居中白字（同 fidelity②）
  assert(sc.g > 100 && sc.r < 90, `renderSinglePage(page3) 背景应绿，得 rgb(${sc.r},${sc.g},${sc.b})`);
  console.log('✓ view_slide 单页路径正确（renderSinglePage 复用同一渲染路径）');

  // ── 历史版本预览（deck 历史窗口右侧缩略图依赖）的底层渲染原语：从任意 sourceHtmlPath 拆页渲染，
  //    内容取自旧版（不是 index.html），但 baseDir 仍 deckPath → images/ 照常解析。
  //    项目B 后 buildHistoryContactSheet 从 fileHistory 中央仓 restore 旧版 → 写临时文件喂这条原语；
  //    此处直接喂一个旧版文件，验的就是这条 sourceHtmlPath 渲染路径不变（端到端见 contactSheet.test）──
  const verHtml = FIXTURE_HTML
    .replace('<section class="slide active" id="s1">PAGE ONE</section>', '<section class="slide active" id="v1" style="background:#7700aa">OLD VERSION</section>')
    .replace('<section class="slide" id="s2">PAGE TWO</section>', '') // 旧版只 2 页（验确实读的是旧版、不是 3 页的 index）
    .replace('#s1 { background: #cc0000; }', '');
  const versionPath = join(deckPath, '.history', 'versions', 'v001.html');
  await fs.mkdir(join(deckPath, '.history', 'versions'), { recursive: true });
  await fs.writeFile(versionPath, verHtml, 'utf-8');
  const ver = await buildContactSheet(deckPath, undefined, versionPath);
  assert(ver.pageCount === 2, `旧版应拆 2 页（证读的是 v001 而非 3 页 index），得 ${ver.pageCount}`);
  const vc = sampleRgb(ver.slideImages[0], 0.5, 0.2); // 旧版首页紫底
  assert(vc.r > 100 && vc.b > 120 && vc.g < 90, `旧版首页应紫底，得 rgb(${vc.r},${vc.g},${vc.b})`);
  const vhero = sampleRgb(ver.slideImages[1], 0.1, 0.12); // 旧版 page3→现 page2 仍引用 images/hero.png
  assert(vhero.r > 180 && vhero.g > 150 && vhero.b < 110, `旧版 images/ 相对图仍解析（baseDir=deckPath），得 rgb(${vhero.r},${vhero.g},${vhero.b})`);
  console.log('✓ 历史版本预览：渲 .history/versions/v{N}.html，内容取旧版、images/ 仍从 deckPath 解析');

  await fs.rm(deckPath, { recursive: true, force: true });

  // ── 非 16:9（验收 2）：4:3 deck 复查图按真实比例渲（1024×768），不被塞进 16:9 压扁 ──
  await runFourThreeCase();

  console.log('\n[CONTACT SHEET SMOKE PASSED] — fidelity spike 通过，决策 1（摘单页+归一化）成立，无需退 iframe');
}

/** 4:3 deck：声明 1024×768，验全分辨率页图按真实比例（非 16:9），中心色正确（vw/vh 未压扁）。 */
async function runFourThreeCase(): Promise<void> {
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta name="oru-deck-size" content="1024x768"><style>
    html, body { height:100%; overflow:hidden; margin:0; }
    .slide { position:absolute; inset:0; width:100vw; height:100vh; opacity:0; visibility:hidden;
             display:flex; align-items:center; justify-content:center; color:#fff; }
    .slide.active { opacity:1; visibility:visible; }
  </style></head>
  <body class="deck">
    <section class="slide active" style="background:#2563eb">4:3 第一页</section>
    <section class="slide" style="background:#16a34a">4:3 第二页</section>
  </body></html>`;
  const deckPath = join(tmpdir(), `oru-cs43-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(deckPath, { recursive: true });
  await fs.writeFile(join(deckPath, 'index.html'), html, 'utf-8');

  const { slideImages, pageCount } = await buildContactSheet(deckPath);
  assert(pageCount === 2, `4:3 应拆 2 页，得 ${pageCount}`);
  for (let i = 0; i < 2; i += 1) {
    const s = sampleRgb(slideImages[i], 0.5, 0.5);
    assert(s.w === 1024 && s.h === 768, `4:3 page${i + 1} 应按声明 1024×768 渲，得 ${s.w}×${s.h}`);
  }
  // 第二页（默认隐藏）经归一化后非空白、背景绿（证明按真实比例铺满、未压扁）
  assert(!isNearWhite(slideImages[1]), '4:3 page2 经归一化后不应空白');
  const c = sampleRgb(slideImages[1], 0.5, 0.2); // 上方背景带，避开居中白字
  assert(c.g > 120 && c.r < 90, `4:3 page2 背景应绿，得 rgb(${c.r},${c.g},${c.b})`);

  await fs.rm(deckPath, { recursive: true, force: true });
  console.log('✓ 非 16:9：4:3 deck 复查图按真实比例 1024×768 渲（验收 2，没压扁成 16:9）');
}
