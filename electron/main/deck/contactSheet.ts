/**
 * 联系表（contact sheet）：把一份 deck 的每页摘成独立 HTML、逐页静态渲染成全尺寸图，
 * 再用离屏 canvas 缩小拼成带页码的网格总览图。给写 deck 的子 agent 一眼看到全局版式。
 *
 * 为什么逐页摘出来单独渲染、而不是驱动 deck 翻页（技术设计决策 1）：
 * deck 是单个 index.html、屏上一次只显一页（JS/CSS 切当前页）；任务 1 渲染原语是静态的，
 * 没有"显示第 N 页"入参（交互驱动推迟到任务 10b）。所以把每页摘成"只含这一页 + 可见性
 * 归一化"的 standalone HTML，在独立 1920×1080 文档里渲染——vw/vh 按真实视口算、版式不失真，
 * 再缩放拼接（纯图像操作、不碰布局）。逐页全尺寸图同时服务 view_slide 深查，同一条渲染路径。
 *
 * 本模块纯图像：不知道"工具"、不知道"模型"、不知道 runner。拆页 + 取画布复用 deckModel
 * （单一来源），不平行造第二套 parse。composeGrid 沿用 imageDecoder.ts 的离屏 canvas 套路（它只做
 * 单张 decode，多张合成是新写）。
 */
import { segmentSlides, getCanvas, DEFAULT_CANVAS, type DeckCanvas } from './deckModel';
import { renderHtmlToImage } from '../render/htmlRenderer';

export type ContactSheetResult = {
  /** 一张或多张网格图 base64（不含 data: 前缀）；大 deck 分多张 */
  sheetImages: string[];
  /** 每页全分辨率图 base64，下标 = pageIndex（供 composeGrid / view_slide） */
  slideImages: string[];
  pageCount: number;
};

/**
 * 网格布局常量（与画布尺寸无关的部分）。单元格尺寸不写死——按 deck 声明的画布比例派生（gridCell）。
 * 受任务 1 模型分辨率上限约束（联系表图也喂模型看）——单元格长边 600px、3 列下网格图长边 ~1880px，
 * 各比例下都在上限内、不会压糊。
 */
export const GRID = {
  cols: 3,
  rows: 3,
  cellLong: 600, // 单元格长边目标像素；短边按画布比例派生
  gap: 16,
  padding: 24,
  badge: { width: 40, height: 28 }, // 页码徽标
} as const;

/**
 * 按画布比例派生单元格尺寸：横版/方形定宽（cellWidth=cellLong）、竖版定高（cellHeight=cellLong），
 * 另一维按画布比例派生。16:9（1920×1080）→ 600×338，与历史写死值逐像素一致（回归不变）。
 */
export function gridCell(canvas: DeckCanvas): { cellWidth: number; cellHeight: number } {
  const { width: w, height: h } = canvas;
  if (w >= h) return { cellWidth: GRID.cellLong, cellHeight: Math.round((GRID.cellLong * h) / w) };
  return { cellWidth: Math.round((GRID.cellLong * w) / h), cellHeight: GRID.cellLong };
}

const SLIDES_PER_SHEET = GRID.cols * GRID.rows; // 9
/** 单次 render_contact_sheet 返回的网格图上限——别一次把十几张大图灌进模型上下文（技术设计 §5） */
export const MAX_SHEETS_PER_CALL = 6;

/**
 * 单页渲染归一化 CSS：让摘出的单页**完全按"激活页"的样子**渲染。deck 源 `.slide` 无显式尺寸、
 * 靠运行时（deckFrameCss 激活页 display:flex + 注入画布尺寸）显示，故这里补齐：
 * - 定尺到画布（width/height）：源文件没有，不补则内容稀疏的页只有内容高、垂直居中失效；
 * - display:flex（非 block）：保住 deck 用 flex 做的垂直/水平居中，贴合 deckFrameCss 激活页契约；
 * - 强制可见：中和"只显当前页"的隐藏手段（display:none / opacity:0 / transform / 绝对定位偏移）；
 * - position:relative（非 static）：保住页内绝对定位子元素的包含块。
 * 注入在 head 末尾（!important + 后置，压过 deck 自身规则）。
 */
export function slideRenderCss({ width, height }: DeckCanvas): string {
  return (
    'html,body{margin:0!important;padding:0!important;height:auto!important;overflow:visible!important}' +
    '.slide{display:flex!important;opacity:1!important;visibility:visible!important;' +
    'position:relative!important;transform:none!important;left:auto!important;top:auto!important;' +
    `inset:auto!important;margin:0!important;width:${width}px!important;height:${height}px!important}`
  );
}

/** 从完整 deck HTML 取 <head> 内容 + <body> 开标签（保留 body 的 class/属性，影响选择器与背景）。 */
export function extractHeadAndBody(html: string): { head: string; bodyOpenTag: string } {
  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const bodyMatch = html.match(/<body\b[^>]*>/i);
  return {
    head: headMatch ? headMatch[1] : '',
    bodyOpenTag: bodyMatch ? bodyMatch[0] : '<body>',
  };
}

/**
 * 组装"只含第 i 页 + 归一化样式"的 standalone HTML。归一化样式后置、压过 deck 自身隐藏规则。
 * 归一化 CSS 由调用方传：联系表/导出用视觉保真归一化（slideRenderCss），deck 校验器传它自己的
 * 测量专用归一化（measureNormalizeCss）——骨架共用一份，各传各的 CSS（系统性）。
 */
export function assembleStandalonePage(
  head: string,
  bodyOpenTag: string,
  slideHtml: string,
  normalizeCss: string,
): string {
  return (
    `<!doctype html><html><head>${head}<style>${normalizeCss}</style></head>` +
    `${bodyOpenTag}${slideHtml}</body></html>`
  );
}

/** 网格布局规划（纯函数，单测覆盖）：pageCount → 若干网格图、每图的单元格坐标 + 该格页号。 */
export type SheetCell = { page: number; x: number; y: number; w: number; h: number };
export type SheetPlan = { pages: number[]; width: number; height: number; cells: SheetCell[] };

export function planContactSheets(pageCount: number, canvas: DeckCanvas = DEFAULT_CANVAS): SheetPlan[] {
  const sheets: SheetPlan[] = [];
  const { cols, rows, gap, padding } = GRID;
  const { cellWidth, cellHeight } = gridCell(canvas);
  const width = padding * 2 + cols * cellWidth + (cols - 1) * gap;
  const height = padding * 2 + rows * cellHeight + (rows - 1) * gap;
  for (let start = 0; start < pageCount; start += SLIDES_PER_SHEET) {
    const pages: number[] = [];
    const cells: SheetCell[] = [];
    for (let k = 0; k < SLIDES_PER_SHEET && start + k < pageCount; k += 1) {
      const page = start + k;
      const col = k % cols;
      const row = Math.floor(k / cols);
      pages.push(page);
      cells.push({
        page,
        x: padding + col * (cellWidth + gap),
        y: padding + row * (cellHeight + gap),
        w: cellWidth,
        h: cellHeight,
      });
    }
    sheets.push({ pages, width, height, cells });
  }
  return sheets;
}

/**
 * 大 deck 分批：选第 batch 批（1 起）的网格图区间。
 * 返回钳位后的 batchIndex（调用方拼文案直接用，不重算钳位逻辑）。
 */
export function selectSheetBatch(
  totalSheets: number,
  batch: number,
): { startSheet: number; endSheet: number; totalBatches: number; batchIndex: number } {
  const totalBatches = Math.max(1, Math.ceil(totalSheets / MAX_SHEETS_PER_CALL));
  const batchIndex = Math.min(Math.max(1, Math.floor(batch) || 1), totalBatches);
  const startSheet = (batchIndex - 1) * MAX_SHEETS_PER_CALL;
  const endSheet = Math.min(startSheet + MAX_SHEETS_PER_CALL, totalSheets);
  return { startSheet, endSheet, totalBatches, batchIndex };
}

/** 渲染单页全分辨率图：摘出第 page 页 → 归一化 standalone → renderHtmlToImage（inline, baseDir=deckPath）。 */
async function renderOneSlide(
  head: string,
  bodyOpenTag: string,
  slideHtml: string,
  deckPath: string,
  canvas: DeckCanvas,
  signal?: AbortSignal,
  deviceScaleFactor?: number,
): Promise<string> {
  const standalone = assembleStandalonePage(head, bodyOpenTag, slideHtml, slideRenderCss(canvas));
  // 用 inline 源：原语自己往 baseDir(=deckPath) 写唯一名临时文件、渲染后删——images/ 相对图照常解析。
  // 渲染视口 = deck 声明画布（非 16:9 也按真实比例渲，不压扁）；deviceScaleFactor 控清晰度（高清导出调高）。
  const { pngBase64 } = await renderHtmlToImage({
    source: { kind: 'inline', html: standalone, baseDir: deckPath },
    viewport: canvas,
    deviceScaleFactor,
    signal,
  });
  return pngBase64;
}

/**
 * 读 HTML → 拆页 + 拆头体 + 取画布（buildContactSheet / renderSinglePage 共用的纯解析，不共享渲染结果）。
 * 缺省读 deckPath/index.html；sourceHtmlPath 传了则读它（历史版本 .history/versions/v{N}.html）——
 * baseDir 始终是 deckPath，images/ 相对图照常解析。
 */
async function loadSlides(
  deckPath: string,
  sourceHtmlPath?: string,
): Promise<{ slides: string[]; head: string; bodyOpenTag: string; canvas: DeckCanvas }> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const html = await readFile(sourceHtmlPath ?? join(deckPath, 'index.html'), 'utf-8');
  return { slides: segmentSlides(html), canvas: getCanvas(html), ...extractHeadAndBody(html) };
}

/**
 * 构造联系表：读 index.html → 拆页 → 逐页渲染全尺寸图 → composeGrid 合成网格图。
 * @param deckPath deck 目录（含 index.html + images/）
 */
/** 逐页渲染并发上限：并行起多个离屏窗口砍掉串行墙钟，又不让大 deck 同时开十几个窗口耗内存。 */
const RENDER_CONCURRENCY = 4;

/**
 * 逐页渲染 deck 全分辨率图（保持页序），返回每页 base64 + 画布尺寸。
 * 联系表（缩成网格）与 PPT 导出（满版铺图）共用这一条 deck→逐页图路径，不另写第二套。
 *
 * 有界并发（保持页序）：12-20 页的大 deck 串行要 10-40s，并发 4 路显著缩短，
 * 又不像"全并行"那样同时开 N 个离屏窗口把内存打爆。
 */
export async function renderAllSlides(
  deckPath: string,
  signal?: AbortSignal,
  opts?: {
    /** 截图像素密度（清晰度档位）；缺省 1。仅图片版导出调高，联系表/view_slide 用默认。 */
    deviceScaleFactor?: number;
    /** 逐页渲染完成回调（done 已完成页数，total 总页数）——给导出进度用，按页递增。 */
    onProgress?: (done: number, total: number) => void;
    /** 并发离屏窗口数；缺省 RENDER_CONCURRENCY(4，交互期保守不卡 UI）。导出全屏蒙尘、UI 已停，可调高抢速度。 */
    concurrency?: number;
    /** 渲染源 HTML 路径；缺省 index.html。历史版本预览传 .history/versions/v{N}.html（baseDir 仍 deckPath）。 */
    sourceHtmlPath?: string;
  },
): Promise<{ slideImages: string[]; canvas: DeckCanvas }> {
  const { slides, head, bodyOpenTag, canvas } = await loadSlides(deckPath, opts?.sourceHtmlPath);
  let done = 0;
  opts?.onProgress?.(0, slides.length); // 先报总数：前端进度立刻显示 0/N，不必等第一页渲完
  const slideImages = await mapWithConcurrency(slides, opts?.concurrency ?? RENDER_CONCURRENCY, async (slide) => {
    const img = await renderOneSlide(head, bodyOpenTag, slide, deckPath, canvas, signal, opts?.deviceScaleFactor);
    opts?.onProgress?.((done += 1), slides.length); // 并发完成顺序≠页序，但 done 计数仍单调正确
    return img;
  });
  return { slideImages, canvas };
}

export async function buildContactSheet(
  deckPath: string,
  signal?: AbortSignal,
  sourceHtmlPath?: string,
): Promise<ContactSheetResult> {
  const { slideImages, canvas } = await renderAllSlides(deckPath, signal, { sourceHtmlPath });
  const sheetImages = await composeGrid(slideImages, canvas, signal);
  return { sheetImages, slideImages, pageCount: slideImages.length };
}

/**
 * 渲染某历史版本的联系表网格图——deck 历史窗口右侧预览复用（承重「找回旧版」路径）。
 * 字节从 fileHistory 中央仓取（项目B 第一期起，旧 .history/versions/ 退役），写到 deckPath 下一个
 * 唯一名临时文件当 sourceHtmlPath——baseDir 仍 deckPath，images/ 照常解析；用完即删（非原子，临时态）。
 * 旧版引用的图若已删 → 该位置渲成空白（不崩），恢复前的缺图确认另由 checkoutVersion 把关。
 */
export async function buildHistoryContactSheet(
  artifactId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<ContactSheetResult> {
  const { resolveDeckPath } = await import('./store');
  const { restoreVersionContent } = await import('./history');
  const { join } = await import('node:path');
  const { promises: fsp } = await import('node:fs');
  const deckPath = await resolveDeckPath(artifactId);
  const html = await restoreVersionContent(artifactId, versionId);
  // 临时文件用完即删（随版本可重建，不值原子写）；唯一名避免并发预览不同版本互踩
  const tmpPath = join(deckPath, `.history-preview-${versionId}.html`);
  await fsp.writeFile(tmpPath, html, 'utf-8');
  try {
    return await buildContactSheet(deckPath, signal, tmpPath);
  } finally {
    await fsp.rm(tmpPath, { force: true });
  }
}

/** 有界并发 map，结果按输入顺序回填——单条抛错则整体 reject（abort/渲染失败原样透传）。 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * view_slide 复用：独立读一遍 index.html → 渲染第 page 页（0 起）全分辨率。
 * 不白嫖 buildContactSheet 的中间产物——要反映当前磁盘态（fresh 重渲）。
 */
export async function renderSinglePage(
  deckPath: string,
  page: number,
  signal?: AbortSignal,
): Promise<{ base64: string; canvas: DeckCanvas }> {
  const { slides, head, bodyOpenTag, canvas } = await loadSlides(deckPath);
  if (page < 0 || page >= slides.length) {
    throw new Error(`第 ${page + 1} 页不存在（deck 共 ${slides.length} 页）`);
  }
  const base64 = await renderOneSlide(head, bodyOpenTag, slides[page], deckPath, canvas, signal);
  return { base64, canvas };
}

/**
 * 把 N 张全分辨率页图缩小、网格平铺、叠页码徽标 → 一张或多张联系表图（base64）。
 * 沿用 imageDecoder.ts 的离屏 canvas 套路：开一个离屏窗口、loadURL 空页、executeJavaScript
 * 在渲染进程里用 canvas 合成。一个窗口跑完整批（N 张图共用），跑完销毁。
 */
export async function composeGrid(
  slideImages: string[],
  canvas: DeckCanvas = DEFAULT_CANVAS,
  signal?: AbortSignal,
): Promise<string[]> {
  if (slideImages.length === 0) return [];
  const plans = planContactSheets(slideImages.length, canvas);

  const { BrowserWindow } = await import('electron');
  const win = new BrowserWindow({
    show: false,
    width: 16,
    height: 16,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true },
  });
  try {
    await win.loadURL('data:text/html,<!doctype html><meta charset=utf-8><body></body>');
    const fnSrc = COMPOSE_FN.toString();
    const out: string[] = [];
    for (const plan of plans) {
      if (signal?.aborted) throw new Error('联系表合成已取消'); // 大 deck 合成阶段也要响应取消
      // 该网格图用到的页图：按 cells 顺序取对应 base64
      const cellImages = plan.cells.map((c) => slideImages[c.page]);
      const arg = JSON.stringify({ plan, cellImages, badge: GRID.badge });
      // 渲染进程内 try/catch 把真实错误回传——executeJavaScript 原生只抛泛化"Script failed to execute"，无从排查
      const script = `(async()=>{try{return await (${fnSrc})(${arg})}catch(e){return '__composeError__:'+(e&&e.stack||e)}})()`;
      const dataUrl = (await win.webContents.executeJavaScript(script, true)) as string;
      if (dataUrl.startsWith('__composeError__:')) {
        throw new Error(`联系表合成失败：${dataUrl.slice('__composeError__:'.length)}`);
      }
      out.push(dataUrl.slice(dataUrl.indexOf(',') + 1));
    }
    return out;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 合成脚本在离屏渲染进程里跑：把每页 base64 画进网格单元、叠页码徽标 → toDataURL PNG。
 * 这段在渲染进程 eval，不能引用 main 侧符号。
 */
const COMPOSE_FN = (arg: {
  plan: { width: number; height: number; cells: { page: number; x: number; y: number; w: number; h: number }[] };
  cellImages: string[];
  badge: { width: number; height: number };
}): Promise<string> => {
  const { plan, cellImages, badge } = arg;
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('no 2d ctx'));
  ctx.fillStyle = '#2b2b2b';
  ctx.fillRect(0, 0, plan.width, plan.height);

  // 内层加载器必须是**匿名**箭头：esbuild/tsx 的 keepNames 会给具名内层函数注入 __name(...)
  // 包装，.toString() 带进渲染进程后 __name 未定义即崩（与 imageDecoder.DECODE_FN 同约束）。
  return Promise.all(
    cellImages.map(
      (b64) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('cell img decode error'));
          img.src = `data:image/png;base64,${b64}`;
        }),
    ),
  ).then((imgs) => {
    for (let i = 0; i < plan.cells.length; i += 1) {
      const cell = plan.cells[i];
      // 白底（页可能有透明区），再画缩略图
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
      ctx.drawImage(imgs[i], cell.x, cell.y, cell.w, cell.h);
      // 页码徽标：左上角深底白字（1 起，对齐用户/工具页码语义）
      ctx.fillStyle = 'rgba(20,20,20,0.82)';
      ctx.fillRect(cell.x, cell.y, badge.width, badge.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(cell.page + 1), cell.x + badge.width / 2, cell.y + badge.height / 2);
    }
    return canvas.toDataURL('image/png');
  });
};
