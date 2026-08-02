/**
 * 任意图片字节 → 归一化 PNG 缩略图（Electron 离屏 canvas 解码）。
 *
 * 为什么不是 `nativeImage.createFromBuffer`：spike 实测它只解 PNG/JPEG，**WebP 返回空图**
 * （Electron 限制）。而图床/Tavily 大量返回 WebP。改走离屏 BrowserWindow + canvas——
 * Chromium 自带 WebP/AVIF/GIF 解码，`<img>`→`drawImage`→`toDataURL('image/png')` 一条路径
 * 解所有格式，统一且不引新依赖（详见图片获取技术设计决策 3 + spike 结论）。
 *
 * 只产 PNG：对齐任务 1 `ToolResultImage.mediaType: 'image/png'` 的字面量约束；模型 viewing
 * token 只按像素面积算，PNG/JPEG 字节差异对 token 零影响（决策 3）。
 *
 * 解码失败（坏字节 / 不支持的格式）的条目返回 null，由调用方跳过——不阻断其它候选。
 */

/**
 * 「外来图进模型」的归一宽度上限——各家视觉模型最优分辨率不一，取一个够用的通用值，
 * 留足细节又把超大图与 token 兜住（decodeThumbnails 只按比例缩、不放大）。
 *
 * 适用面是**尺寸不受 Oru 控制的图**：read_file 读本地图片、外部 MCP 工具回传的截图。
 * Oru 自己渲染出来的图（render_html / view_slide / render_contact_sheet）尺寸由渲染参数直接
 * 决定（deck 画布 1920×1080 等），不走这条——它们的"上限"就是渲染时定的那个值。
 */
export const IMAGE_VIEW_MAX_WIDTH = 1568;

export type DecodeInput = { bytes: Uint8Array; mime: string };
export type DecodedThumb = { pngBase64: string; width: number; height: number };

/** 解码脚本在离屏渲染进程里跑：data URI → Image → 降采样 drawImage → PNG base64 */
const DECODE_FN = (dataUri: string, maxW: number): Promise<{ w: number; h: number; b64: string }> => {
  // 这段在渲染进程 eval，不能引用 main 侧符号
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sw = img.naturalWidth;
      const sh = img.naturalHeight;
      if (!sw || !sh) {
        reject(new Error('zero natural size'));
        return;
      }
      // 按**长边**缩，不是按宽度：全页截图的形态是窄而高（1280×15000），只看宽度会原样放行，
      // 而那正是最该挡的一类（单边超过接口像素上限直接 400，或一张图吃掉两万多 token）。
      const longest = Math.max(sw, sh);
      const scale = longest > maxW ? maxW / longest : 1;
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) {
        reject(new Error('no 2d ctx'));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const url = c.toDataURL('image/png');
      resolve({ w, h, b64: url.slice(url.indexOf(',') + 1) });
    };
    img.onerror = () => reject(new Error('img decode error'));
    img.src = dataUri;
  });
};

const DEFAULT_MAX_WIDTH = 512;

export type CompressInput = { bytes: Uint8Array; mime: string };
export type CompressedImage = { bytes: Buffer; width: number; height: number };

/**
 * 离屏把一张图缩放 + JPEG 重编码到「长边 ≤maxW 且字节 ≤maxBytes」以内（在渲染进程 eval）。
 * 先按长边缩到 maxW，再逐档降 JPEG 质量；到最低质量仍超字节则继续按比例缩，直到落进上限。
 * 返回 JPEG base64；解码失败（坏字节 / 不支持格式）reject。
 */
// ⚠ 这段整体 .toString() 后喂 executeJavaScript 在渲染进程 eval——**不能有具名内层函数**
// （含 `const f = () => …`）：esbuild keepNames 会包成 __name(f,'f')，渲染进程无 __name → 崩。
// 故字节估算等辅助一律内联，不抽具名箭头（同 DECODE_FN / contactSheet 的 COMPOSE_FN 纪律）。
const COMPRESS_FN = (
  dataUri: string,
  maxW: number,
  maxBytes: number,
): Promise<{ w: number; h: number; b64: string }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sw = img.naturalWidth;
      const sh = img.naturalHeight;
      if (!sw || !sh) {
        reject(new Error('zero natural size'));
        return;
      }
      const qualities = [0.85, 0.7, 0.55, 0.4];
      const ATTEMPTS = 8; // 每档把长边再砍 15%，兜极端大图 / 极小 maxBytes 的收敛
      let scale = sw > maxW ? maxW / sw : 1;
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const w = Math.max(1, Math.round(sw * scale));
        const h = Math.max(1, Math.round(sh * scale));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cx = c.getContext('2d');
        if (!cx) {
          reject(new Error('no 2d ctx'));
          return;
        }
        cx.drawImage(img, 0, 0, w, h);
        const last = attempt === ATTEMPTS - 1;
        for (const q of qualities) {
          const url = c.toDataURL('image/jpeg', q);
          const b64 = url.slice(url.indexOf(',') + 1);
          // base64 段字节 ≈ len*3/4。落进上限即收；到最后一档最低质量仍超也收当前最优（不死磕）。
          if (Math.floor((b64.length * 3) / 4) <= maxBytes || (last && q === 0.4)) {
            resolve({ w, h, b64 });
            return;
          }
        }
        scale *= 0.85;
      }
    };
    img.onerror = () => reject(new Error('img decode error'));
    img.src = dataUri;
  });
};

/**
 * 批量把超限图缩放压缩到模型的尺寸/大小限制内（S34 · G25）——单个失败该位置返回 null，由调用方处置。
 * 共用一个离屏窗口跑完整批后销毁（同 decodeThumbnails）。
 */
export async function compressImagesToLimit(
  inputs: CompressInput[],
  maxWidth: number,
  maxBytes: number,
): Promise<Array<CompressedImage | null>> {
  if (inputs.length === 0) return [];
  const { BrowserWindow } = await import('electron');
  const win = new BrowserWindow({
    show: false,
    width: 16,
    height: 16,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true },
  });
  try {
    await win.loadURL('data:text/html,<!doctype html><meta charset=utf-8><body></body>');
    const fnSrc = COMPRESS_FN.toString();
    const out: Array<CompressedImage | null> = [];
    for (const inp of inputs) {
      const dataUri = `data:${inp.mime};base64,${Buffer.from(inp.bytes).toString('base64')}`;
      const script = `(${fnSrc})(${JSON.stringify(dataUri)}, ${JSON.stringify(maxWidth)}, ${JSON.stringify(maxBytes)})`;
      try {
        const r = (await win.webContents.executeJavaScript(script, true)) as {
          w: number;
          h: number;
          b64: string;
        };
        out.push(
          r.b64 && r.b64.length > 0
            ? { bytes: Buffer.from(r.b64, 'base64'), width: r.w, height: r.h }
            : null,
        );
      } catch {
        out.push(null);
      }
    }
    return out;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 批量解码 + 降采样到 ≤maxWidth，统一产 PNG base64。
 * 单个解码失败 → 该位置返回 null（坏图跳过，不阻断其它）。
 * 用一个离屏窗口跑完整批后销毁——N 张缩略图共用，避免每张建窗口。
 */
export async function decodeThumbnails(
  inputs: DecodeInput[],
  maxWidth: number = DEFAULT_MAX_WIDTH,
): Promise<Array<DecodedThumb | null>> {
  if (inputs.length === 0) return [];
  // 动态 import：让本模块在非 Electron（tsx 单测/smoke）上下文里也能被 import 而不炸——
  // 只有真正调用解码时才碰 electron（同 htmlRenderer.ts 的处理）。
  const { BrowserWindow } = await import('electron');
  const win = new BrowserWindow({
    show: false,
    width: 16,
    height: 16,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true },
  });
  try {
    await win.loadURL('data:text/html,<!doctype html><meta charset=utf-8><body></body>');
    const fnSrc = DECODE_FN.toString();
    const out: Array<DecodedThumb | null> = [];
    // 串行逐张 executeJavaScript：共用同一 webContents，串行最稳（N≤6，IPC 往返可忽略）；
    // 同一渲染进程并发多个 executeJavaScript 收益不明、徒增复杂，按克制不做。
    for (const inp of inputs) {
      const dataUri = `data:${inp.mime};base64,${Buffer.from(inp.bytes).toString('base64')}`;
      const script = `(${fnSrc})(${JSON.stringify(dataUri)}, ${JSON.stringify(maxWidth)})`;
      try {
        const r = (await win.webContents.executeJavaScript(script, true)) as {
          w: number;
          h: number;
          b64: string;
        };
        out.push(r.b64 && r.b64.length > 0 ? { pngBase64: r.b64, width: r.w, height: r.h } : null);
      } catch {
        out.push(null); // 坏图 / 不支持格式：跳过
      }
    }
    return out;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
