/**
 * 离屏渲染原语 —— 给一段 HTML，还一张截图。
 *
 * 这一层**只管渲染**：起一个用户看不见的 BrowserWindow、加载 HTML、等渲染 settle、
 * 截一屏、销毁窗口。它不知道"工具"、不知道"模型"——纯渲染原语，别的能力都搭在它上面。
 *
 * 实现要点（spike 见 docs/tech/2026-06-01-render-eyes-tech-design.md §5；截图机制 2026-06-16 改 CDP）：
 * - `offscreen:true` 纯内存渲染：不建可见 OS 窗口（逐页导出彻底静默），且截图走原始 sRGB、不烤入
 *   显示器 ICC 色彩配置。（旧 capturePage 时代 offscreen 截白图、必须 showInactive 显示窗口；CDP
 *   captureScreenshot 独立合成，offscreen 既能截全、又静默又色准——一举解决闪窗与色偏。）
 * - 截图走 CDP `Page.captureScreenshot` + `captureBeyondViewport`，配 `Emulation.setDeviceMetricsOverride`
 *   把布局视口锁到画布尺寸：截图与窗口物理尺寸彻底解耦——小屏上窗口被 OS 钳小也照样合成整张画布，
 *   不再像 `capturePage` 只截到可视窗口区、把右/下内容切掉（旧 `fitWindowToScreen+enableDeviceEmulation`
 *   只改布局、不改可截区域，实测仍截断，已废弃）。deviceScaleFactor:1 → 截图即 logical 尺寸、跨机一致。
 */
import type { NativeImage, WebContents } from 'electron';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type RenderRequest = {
  /** 二选一：HTML 文件绝对路径，或内联 HTML 文本（内联必带 baseDir，作相对资源解析根） */
  source: { kind: 'file'; path: string } | { kind: 'inline'; html: string; baseDir: string };
  /** 从文档顶部向下滚动多少像素后截这一屏；默认 0 = 首屏。长页看后续屏用。 */
  scrollY?: number;
  /** 渲染视口（= 截出图的 logical 尺寸）；默认 1920×1080。 */
  viewport?: { width: number; height: number };
  /**
   * 截图像素密度（CDP deviceScaleFactor）；默认 1 = 出图即 logical 尺寸。
   * 调高（2/3）→ 出图分辨率成倍、文字/边缘更锐（用于高清导出），代价是体积与渲染耗时增大。
   */
  deviceScaleFactor?: number;
  /** 总超时（毫秒）；默认 10000。超时 → 销毁窗口 + 抛可解释错误。 */
  timeoutMs?: number;
  /** 调用方的中断信号；abort 时尽快销毁窗口、不留孤儿。 */
  signal?: AbortSignal;
};

export type RenderResult = {
  /** PNG 的 base64（不含 data: 前缀） */
  pngBase64: string;
  meta: {
    /** 截出图的尺寸（= viewport logical 尺寸；CDP dpr=1 原生即此尺寸，无需 resize） */
    width: number;
    height: number;
    /** 文档总高（document.documentElement.scrollHeight，CSS 像素） */
    contentHeight: number;
    /** scrollY + viewport.height < contentHeight —— 下面还有没截到的屏 */
    hasMore: boolean;
    /** 截图接近全白：页面可能没渲染出可见内容（仍返回图，由上层据此提示） */
    isBlank: boolean;
  };
};

/** 渲染失败——带可读 message，由工具层 catch 成 ToolResult{isError, text}。 */
export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const DEFAULT_TIMEOUT_MS = 10_000;
const SETTLE_MS = 120; // spike 实测：120ms 足够 settle 布局/图片 onload 的最后抖动

/**
 * 离屏渲染页面句柄：交给 `withOffscreenPage` 的回调，用来在已 settle 的页面里跑探针 / 截图。
 * 窗口生命周期（建窗/加载/字体 settle/超时/abort/清理）由 `withOffscreenPage` 全包，回调只管量度。
 */
export type OffscreenPage = {
  webContents: WebContents;
  /** 渲染视口（CDP 已把布局锁到此 logical 尺寸，截图也即此尺寸）。 */
  viewport: { width: number; height: number };
  /** 给探针 / 截图套窗口共用的总超时 + abort（与加载/字体共享一个 deadline）。 */
  guard: <T>(p: Promise<T>, label: string) => Promise<T>;
  /**
   * 截一张满 viewport 的图（CDP captureBeyondViewport，与窗口物理尺寸无关、不会截断）。
   * scrollY：从文档顶向下截这一屏（长页看后续屏用，默认 0）。返回 NativeImage（可能是空白页，
   * 由调用方据 isEmpty/isNearWhite 判定；本函数只在 CDP 真返回空数据时抛错）。
   */
  capture: (scrollY?: number) => Promise<NativeImage>;
  signal?: AbortSignal;
};

/**
 * 离屏渲染生命周期的唯一实现：起一个屏幕外 BrowserWindow、加载 HTML、等字体 settle，
 * 把页面句柄交给 `fn` 跑自定义量度（探针 / 截图），无论成败都销毁窗口、删内联临时文件。
 *
 * 这是"渲染一段 HTML 拿量度"的底座——`renderHtmlToImage`（截图）与 deck 校验器的 `measureSlide`
 * （溢出探针 + 空白判定）都是它的消费者：离屏窗口的建/载/超时/清理只此一份，量度策略分层在上。
 *
 * abort 双路径协同：`onAbort` 立刻销毁窗口；`guard`（= withTimeout）内部 reject 当前等待。
 * 改 abort 行为两处都要看；finally 的 isDestroyed() 守重复 destroy。
 */
export async function withOffscreenPage<T>(
  req: RenderRequest,
  fn: (page: OffscreenPage) => Promise<T>,
): Promise<T> {
  const viewport = req.viewport ?? DEFAULT_VIEWPORT;
  // 总超时（决策 4 的安全阀）：所有步骤共用一个 deadline，而非每步各拿满 timeoutMs——
  // 否则 load/字体/量度串起来最坏会拖到数倍 timeout 才释放，与"总超时"语义不符。
  const deadline = Date.now() + (req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remaining = () => Math.max(0, deadline - Date.now());
  const guard = <U>(p: Promise<U>, label: string): Promise<U> =>
    withTimeout(p, remaining(), req.signal, label);

  if (req.signal?.aborted) throw new RenderError('渲染已取消');

  // 动态 import：electron 只在 Electron 主进程运行时有具名导出。延到调用时加载，
  // 本模块才能被纯 Node（tsx smoke 注册工具）安全 import 而不崩。
  const { BrowserWindow, nativeImage } = await import('electron');
  // 窗口物理尺寸与截图无关（CDP captureBeyondViewport 自行合成整张画布）——请求 viewport 尺寸即可。
  // offscreen:true：纯内存离屏渲染，**根本不建可见 OS 窗口**（逐页导出彻底静默，无窗口闪现）；
  // 且截图走原始 sRGB、不烤入显示器 ICC 色彩配置（onscreen 合成路径会，导致导出颜色偏移）。
  // 旧注释「offscreen 截白图」是 capturePage 时代的坑——CDP Page.captureScreenshot 独立合成，不受此限。
  const win = new BrowserWindow({
    width: viewport.width,
    height: viewport.height,
    show: false,
    x: -32000,
    y: -32000, // 建在屏幕外：offscreen 本就不显示，仅防御性
    webPreferences: {
      offscreen: true, // 纯内存渲染：静默 + 色彩忠实（配 CDP 截图，见上）
      nodeIntegration: false, // 隔离不可信 HTML：页面脚本拿不到 Node
      contextIsolation: true,
      sandbox: false, // 与主窗口一致的已验证截图配置；隔离靠上面两项，不靠 sandbox
      webSecurity: true,
    },
  });
  // offscreen 默认 60fps 连续重绘，但我们只用 CDP 单次截图、不消费 paint 帧——压到 1fps
  // 砍掉这份无用的持续 GPU/CPU 重绘（导出 N 页时尤其明显），降低对主 UI 的卡顿。
  win.webContents.setFrameRate(1);

  let tmp: string | undefined;
  const onAbort = () => win.destroy();
  req.signal?.addEventListener('abort', onAbort, { once: true });
  // 补查：信号可能在上面 await import / new BrowserWindow 期间已触发——addEventListener
  // 对已 abort 的 signal 不补发事件，不补查会让窗口空转到超时才被 finally 销毁。
  // 这里 throw 在 try 之外、不经 finally，需手动摘掉刚注册的 onAbort（否则共享同一 signal 的
  // 连续调用——如校验器逐页——会在该 signal 上累积无效 listener）。
  if (req.signal?.aborted) {
    req.signal.removeEventListener('abort', onAbort);
    win.destroy();
    throw new RenderError('渲染已取消');
  }

  const dbg = win.webContents.debugger;
  try {
    // 1. 加载——base 目录决定相对资源解析：file 直接 loadFile；inline 写进 baseDir 再 loadFile
    if (req.source.kind === 'file') {
      await guard(win.loadFile(req.source.path), '加载超时');
    } else {
      tmp = await writeTempHtml(req.source.html, req.source.baseDir);
      await guard(win.loadFile(tmp), '加载超时');
    }

    // 2. 等渲染 settle：字体就位 + 一个短延迟兜底（did-finish-load 已由 loadFile 等过）
    await guard(win.webContents.executeJavaScript('document.fonts.ready.then(() => true)'), '等待字体就位超时');
    await guard(delay(SETTLE_MS), 'settle 超时'); // 经 guard：settle 期间可被 abort/总超时立刻抢断，不空等

    // 3. 经 CDP 把布局视口锁到 viewport（与窗口物理尺寸解耦）：固定 px 设计在小屏窗口里也按画布布局，
    //    且让 captureBeyondViewport 知道整张画布尺寸。触发重排，再 settle 一次。
    dbg.attach('1.3');
    await guard(
      dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        // 默认 1 → 截图即 logical 尺寸、跨显示器一致（不随真实 dpr 放大）；调用方可调高做高清导出。
        deviceScaleFactor: req.deviceScaleFactor ?? 1,
        mobile: false,
      }),
      '设置视口超时',
    );
    await guard(delay(SETTLE_MS), 'settle 超时'); // 同上：经 guard，abort/超时立刻抢断

    // 4. 截图原语：CDP 满 viewport 截图，与窗口可见区无关——小屏上不再截断右/下内容。
    const capture = async (scrollY = 0): Promise<NativeImage> => {
      const res = (await guard(
        dbg.sendCommand('Page.captureScreenshot', {
          format: 'png',
          // clip.scale 是 CDP 必填字段（缺则 Invalid parameters）；取 1 不额外缩放——截图尺寸由 viewport
          // 与 deviceScaleFactor:1 决定，与 clip.scale 无关，别为缩体积动它（会改输出尺寸）。
          clip: { x: 0, y: scrollY, width: viewport.width, height: viewport.height, scale: 1 },
          captureBeyondViewport: true, // 合成超出可视窗口的区域，整张画布都截到
        }),
        '截图超时',
      )) as { data: string };
      return nativeImage.createFromBuffer(Buffer.from(res.data, 'base64'));
    };

    // 5. 交给消费者跑量度（截图 / 探针），仍走窗口共用的 guard 总超时
    return await fn({ webContents: win.webContents, viewport, guard, capture, signal: req.signal });
  } finally {
    req.signal?.removeEventListener('abort', onAbort);
    // 先摘 CDP debugger：webContents 已销毁/未 attach 时 detach 行为未文档化，故 isDestroyed + isAttached
    // 双守 + try 兜底（窗口销毁本就会自动解绑，detach 万一抛错也不该掩盖业务错误）。
    try {
      if (!win.isDestroyed() && dbg.isAttached()) dbg.detach();
    } catch {
      /* 已自动解绑，忽略 */
    }
    if (!win.isDestroyed()) win.destroy(); // 用完即销毁，不留孤儿窗口
    if (tmp) await rm(tmp).catch(() => {}); // 量度已拿到，安全删内联临时文件
  }
}

export async function renderHtmlToImage(req: RenderRequest): Promise<RenderResult> {
  const scrollY = req.scrollY ?? 0;
  return withOffscreenPage(req, async ({ webContents, viewport, guard, capture }) => {
    // 1. 量文档总高（判断长页是否还有后续屏）；不必滚动——截图由 clip.y=scrollY 直接定位那一屏。
    const contentHeight: number = await guard(
      webContents.executeJavaScript('document.documentElement.scrollHeight'),
      '测量超时',
    );

    // 2. 截当前一屏（满 viewport，logical 尺寸，无截断）→ PNG base64。
    const img = await capture(scrollY);
    if (img.isEmpty()) {
      throw new RenderError('截图为空：HTML 可能未渲染出任何可见内容');
    }

    return {
      pngBase64: img.toPNG().toString('base64'),
      meta: {
        width: viewport.width,
        height: viewport.height,
        contentHeight,
        hasMore: scrollY + viewport.height < contentHeight,
        isBlank: isNearWhite(img),
      },
    };
  });
}

/** 内联 HTML 写进 baseDir（分身可写区），唯一前缀名，渲染后删。 */
export async function writeTempHtml(html: string, baseDir: string): Promise<string> {
  // 唯一名：时间戳 + 随机；不依赖 crypto，避免外部依赖
  const name = `.render-tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}.html`;
  const path = join(baseDir, name);
  await writeFile(path, html, 'utf-8');
  return path;
}

/**
 * 采样网格判断是否接近全白（页面渲染了但视觉空白）。不抛错——合法白页也成立，只作提示。
 * 导出供 deck 校验器复用：空白判定全局同一份，不另写第二套（系统性）。
 */
export function isNearWhite(img: Pick<NativeImage, 'getSize' | 'toBitmap'>): boolean {
  const { width, height } = img.getSize();
  if (width === 0 || height === 0) return true;
  const bmp = img.toBitmap(); // BGRA
  const STEP = 16; // 16×16 网格采样，够判断又便宜
  let nonWhite = 0;
  let sampled = 0;
  for (let gy = 0; gy < STEP; gy += 1) {
    for (let gx = 0; gx < STEP; gx += 1) {
      const x = Math.floor((gx + 0.5) * (width / STEP));
      const y = Math.floor((gy + 0.5) * (height / STEP));
      const i = (y * width + x) * 4;
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      sampled += 1;
      if (r < 248 || g < 248 || b < 248) nonWhite += 1;
    }
  }
  return nonWhite / sampled < 0.01; // 99%+ 采样点接近纯白才算空白
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** 给一个 promise 套总超时 + abort；超时/中断时 reject RenderError。 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new RenderError('渲染已取消')); // 已 abort：addEventListener 不补发
    const timer = setTimeout(
      () => reject(new RenderError(`渲染${label}（${ms}ms）：HTML 可能有未结束的脚本或加载不出的资源`)),
      ms,
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RenderError('渲染已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? new RenderError(`渲染失败：${e.message}`) : e);
      },
    );
  });
}
