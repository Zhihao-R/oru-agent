/**
 * Deck 校验器 detect smoke（任务 7 核心，PRD 验收 1/5/6）——验**检测真的生效**且**不误伤**。
 *
 * 需真实 BrowserWindow 渲染（溢出/空白靠量度），由 deckValidateBootstrap.mjs 在 electron 进程内调。
 *
 * 用一份"各含一处硬伤"的 deck 验四类检测都报得准（页号 + kind 对）：
 *  - 干净页 → 无错（含合法 px border、无显式尺寸声明，验决策 1/4 不误伤）
 *  - 溢出页 → overflow。**关键**：用"绝对定位子元素溢出 + .slide 自身 absolute"——验决策 2 的测量
 *    归一化用 position:relative（而非 static）没把这种最常见的 deck 排版漏判（static 会让绝对定位
 *    子元素的包含块上溯到视口、不计入 .slide.scrollHeight）。
 *  - 空白页（近白）→ blank，且**不**叠报 overflow（互斥优先）。
 *  - 裂图页（引用 images/missing.png）→ broken-image。
 * 再验：一份干净 deck → 零问题；一份无 slide 的 deck → page:null structure。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deckValidator } from '../../../electron/main/deck/deckValidator';
import type { DeckValidationError } from '../../../electron/main/deck/validateDeck';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

function find(errors: DeckValidationError[], page: number | null, kind: DeckValidationError['kind']): boolean {
  return errors.some((e) => e.page === page && e.kind === kind);
}

/**
 * 各含一处硬伤的 deck：page1 干净 / page2 溢出（绝对定位子元素 1500px 高，超 1080 页框）/
 * page3 近白空白 / page4 裂图（images/missing.png 不存在）。
 * 隐藏机制 = .slide 绝对定位 + opacity/visibility（仅 .active 可见），逼测量归一化把隐藏页带进视口。
 */
const DIRTY_DECK = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; font-family: system-ui, sans-serif; }
  .slide {
    position: absolute; inset: 0; width: 100vw; height: 100vh; overflow: hidden;
    opacity: 0; visibility: hidden;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 4vw;
  }
  .slide.active { opacity: 1; visibility: visible; }
  #s1 { background: #1d4ed8; border: 2px solid #fff; }   /* 干净：合法 px border */
  #s2 { background: #047857; }
  #s3 { background: #ffffff; }                            /* 空白：白底无内容 */
  #s4 { background: #b91c1c; }
  /* 绝对定位子元素溢出页框（高 1500 > 1080）：position:relative 归一化才计得进 .slide.scrollHeight */
  .overflow-child { position: absolute; top: 0; left: 0; width: 200px; height: 1500px; background: #f59e0b; }
</style></head>
<body class="deck">
  <section class="slide active" id="s1">干净页 · 文本居中</section>
  <section class="slide" id="s2"><div class="overflow-child"></div>溢出页</section>
  <section class="slide" id="s3"></section>
  <section class="slide" id="s4"><img src="images/missing.png" alt="x">裂图页</section>
</body></html>`;

/** 全干净 deck（4 页都正常、无 images、无溢出/空白）：验不误伤。 */
const CLEAN_DECK = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; font-family: system-ui, sans-serif; }
  .slide {
    position: absolute; inset: 0; width: 100vw; height: 100vh; overflow: hidden;
    opacity: 0; visibility: hidden;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 4vw; background: #334155; border: 1px solid #fff;
  }
  .slide.active { opacity: 1; visibility: visible; }
</style></head>
<body class="deck">
  <section class="slide active">第一页</section>
  <section class="slide">第二页</section>
  <section class="slide">第三页</section>
  <section class="slide">第四页</section>
</body></html>`;

/**
 * skill-agnostic：每页是 `<div class="slide">`（不是 section）。验切页放宽——validator 切得出页、
 * 逐页量得到（page2 溢出）。改前 splitSlides 只认 section.slide → 这份会被判 0 页 structure。
 */
const DIV_SLIDE_DECK = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; font-family: system-ui, sans-serif; }
  .slide {
    position: absolute; inset: 0; width: 100vw; height: 100vh; overflow: hidden;
    opacity: 0; visibility: hidden; display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 4vw;
  }
  .slide.active { opacity: 1; visibility: visible; }
  .overflow-child { position: absolute; top: 0; left: 0; width: 200px; height: 1500px; background: #f59e0b; }
</style></head>
<body class="deck">
  <div class="slide active" style="background:#1d4ed8">div.slide 第一页（干净）</div>
  <div class="slide" style="background:#047857"><div class="overflow-child"></div>div.slide 第二页（溢出）</div>
</body></html>`;

/**
 * 4:3 固定 px deck（M1）：声明 1024×768、.slide 钉死 1024×768 px。page1 子元素高 900px——
 * 超 768（4:3 真实画框）但不超 1080（旧 16:9 写死画框）。验"溢出对声明画布判"：
 * 改前对 16:9 判 → 900<1080 漏报；改后对 768 判 → 报 overflow。page2 子元素 700px 在框内 → 干净。
 */
const FOUR_THREE_DECK = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="oru-deck-size" content="1024x768"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { overflow: hidden; font-family: system-ui, sans-serif; }
  .slide {
    position: absolute; inset: 0; width: 1024px; height: 768px; overflow: hidden;
    opacity: 0; visibility: hidden; background: #334155; color: #fff;
  }
  .slide.active { opacity: 1; visibility: visible; }
  .tall { position: absolute; top: 0; left: 0; width: 100px; height: 900px; background: #f59e0b; }
  .ok { position: absolute; top: 0; left: 0; width: 100px; height: 700px; background: #10b981; }
</style></head>
<body class="deck">
  <section class="slide active"><div class="tall"></div>4:3 溢出页</section>
  <section class="slide"><div class="ok"></div>4:3 干净页</section>
</body></html>`;

/** 远程图（M3）：只引用 http(s) 图、无本地 images/ → 不该报 broken-image（远程不探测、不误报）。 */
const REMOTE_IMG_DECK = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
  html, body { height: 100%; overflow: hidden; margin: 0; }
  .slide { position: absolute; inset: 0; width: 100vw; height: 100vh; background: #222; }
</style></head>
<body class="deck">
  <section class="slide"><img src="https://example.com/remote.png" alt="x" style="width:200px;height:200px"></section>
</body></html>`;

/** 混合（§四）：1 个 .slide 页 + 一坨在 .slide 之外的可见文字 → unrecognized（page:null），页仍逐页查。 */
const MIXED_DECK = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>
  html, body { height: 100%; margin: 0; }
  .slide { position: absolute; inset: 0; width: 100vw; height: 100vh; background: #1e293b; color:#fff; }
</style></head>
<body class="deck">
  <section class="slide active">规范页</section>
  <div style="padding:40px;font-size:24px">这是一段没有被识别为页的额外内容，本该是一页但结构不符合分页约定，应当被如实提示存在未识别内容。</div>
</body></html>`;

async function newDeck(html: string): Promise<string> {
  const deckPath = join(tmpdir(), `oru-dv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await fs.mkdir(deckPath, { recursive: true });
  await fs.writeFile(join(deckPath, 'index.html'), html, 'utf-8');
  return deckPath;
}

export async function runDeckValidateSmoke(): Promise<void> {
  // ── 各含一处硬伤 ──
  {
    const deckPath = await newDeck(DIRTY_DECK);
    const errors = await deckValidator(deckPath);
    console.log('dirty deck errors:', JSON.stringify(errors));

    assert(!errors.some((e) => e.page === 1), 'page1 干净页不应报错（含合法 px border、无尺寸声明 → 不误伤）');
    assert(find(errors, 2, 'overflow'), 'page2 绝对定位子元素溢出应报 overflow（验 position:relative 归一化、static 会漏）');
    assert(find(errors, 3, 'blank'), 'page3 近白空白应报 blank');
    assert(!find(errors, 3, 'overflow'), 'page3 空白页不应叠报 overflow（互斥优先）');
    assert(find(errors, 4, 'broken-image'), 'page4 引用 images/missing.png 应报 broken-image');
    // page2 不应被误判空白（有绿底）；page4 不应误判溢出/空白
    assert(!find(errors, 2, 'blank'), 'page2 有内容不应判空白');
    assert(!errors.some((e) => e.page === 4 && (e.kind === 'overflow' || e.kind === 'blank')), 'page4 只该报裂图');
    console.log('✓ 四类硬伤各报得准（页号 + kind 对），干净页不误伤');
  }

  // ── 全干净 deck → 零问题 ──
  {
    const deckPath = await newDeck(CLEAN_DECK);
    const errors = await deckValidator(deckPath);
    console.log('clean deck errors:', JSON.stringify(errors));
    assert(errors.length === 0, `干净 deck 应零问题，得到 ${JSON.stringify(errors)}`);
    console.log('✓ 干净 deck 零问题（不误伤好 deck / 不查风格项）');
  }

  // ── 无 slide → page:null structure ──
  {
    const deckPath = await newDeck('<html><body><div>没有 section.slide</div></body></html>');
    const errors = await deckValidator(deckPath);
    assert(errors.length === 1 && errors[0].page === null && errors[0].kind === 'structure', '无 slide → page:null structure');
    console.log('✓ 无 slide 的 deck 报 deck 整体 structure（page:null）');
  }

  // ── skill-agnostic：div.slide deck 切得出页 + 逐页量到溢出（验切页放宽）──
  {
    const deckPath = await newDeck(DIV_SLIDE_DECK);
    const errors = await deckValidator(deckPath);
    console.log('div.slide deck errors:', JSON.stringify(errors));
    assert(!find(errors, null, 'structure'), 'div.slide deck 不应被判 0 页 structure（切页已放宽到任意标签）');
    assert(find(errors, 2, 'overflow'), 'div.slide 第二页溢出应报 overflow（页切得出且逐页量到）');
    assert(!errors.some((e) => e.page === 1), 'div.slide 第一页干净不误伤');
    console.log('✓ skill-agnostic：<div class="slide"> deck 切得出页、逐页量得到');
  }

  // ── 非 16:9（M1）：4:3 固定 px 溢出对真实画框判 ──
  {
    const deckPath = await newDeck(FOUR_THREE_DECK);
    const errors = await deckValidator(deckPath);
    console.log('4:3 deck errors:', JSON.stringify(errors));
    assert(find(errors, 1, 'overflow'), '4:3 page1 子元素 900px 超 768 画框应报 overflow（对声明画布判，非 16:9）');
    assert(!errors.some((e) => e.page === 2), '4:3 page2 子元素 700px 在 768 框内不应报');
    console.log('✓ 非 16:9：4:3 固定 px 溢出对真实画框（768）判，不对 16:9 判');
  }

  // ── 远程图（M3）不误报失效 ──
  {
    const deckPath = await newDeck(REMOTE_IMG_DECK);
    const errors = await deckValidator(deckPath);
    console.log('remote-img deck errors:', JSON.stringify(errors));
    assert(!find(errors, 1, 'broken-image'), '远程 http(s) 图不该被报 broken-image（只查本地 images/）');
    console.log('✓ 远程图不误报失效（M3 已知缺口、不假装覆盖也不误伤）');
  }

  // ── 混合（§四）：识别得出的页照常查 + 提示存在未识别内容 ──
  {
    const deckPath = await newDeck(MIXED_DECK);
    const errors = await deckValidator(deckPath);
    console.log('mixed deck errors:', JSON.stringify(errors));
    assert(find(errors, null, 'unrecognized'), '混合 deck 应报 page:null unrecognized（提示存在未识别内容）');
    console.log('✓ 部分认不出：识别页照常把关 + 如实提示未识别内容（无法点名第几页）');
  }

  console.log('\n✅ deckValidate detect smoke 全通过');
}
