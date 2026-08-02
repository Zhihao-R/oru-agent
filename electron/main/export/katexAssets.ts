/**
 * KaTeX 的 vendored 资源内联 —— 导出物自包含的硬要求（技术方案 §四）。
 *
 * katex.min.css 含约 60 处 `url(fonts/KaTeX_*.woff2|woff|ttf)` 相对引用；导出物断网或被移走源目录后
 * 这些字体找不到、公式排版崩。这里只内联 woff2（Chromium 离屏渲染与现代浏览器都支持），并剥掉 woff/ttf
 * 后备引用——得到真自包含、零 `fonts/` 相对引用、且最小体积的样式。
 *
 * 明知的边界：不支持 woff2 的老环境（IE11/某些政企内网浏览器）打开 HTML 出口时公式字体会回退而非崩
 * （KaTeX 有 MathML/HTML 双轨，公式仍可读，只是字形不对）。为这 1% 老环境背一倍字体体积不划算，故取舍如此。
 *
 * 放主进程（非渲染端）：katex.min.css 与字体都是 node_modules 资源，只有主进程能读盘——css 与字体同处
 * 处理才连贯。HTML 出口与 PDF 出口都注入这一份 <style>。
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// 只认 woff2（不含 woff/ttf）：内联逻辑专做 woff2，故即使后备剥除失效，也只会留下 woff/ttf 悬空引用
// （被 buildKatexStyleTag 的「无 fonts/ 相对引用」断言当场抓出），绝不会把 woff/ttf 字节误标成 woff2 内联。
const FONT_URL = /url\(fonts\/(KaTeX_[\w-]+\.woff2)\)/g;
// woff2 之后的后备：`,url(fonts/x.woff) format("woff"),url(fonts/x.ttf) format("truetype")`，整段剥掉。
const FALLBACK = /,url\(fonts\/KaTeX_[\w-]+\.(?:woff|ttf)\)\s*format\("[^"]*"\)/g;

/**
 * 把 css 里的 katex woff2 字体转 data URI 内联、剥掉 woff/ttf 后备。纯函数（IO 经 readFont 注入），可单测。
 * @param readFont 字体文件名（如 `KaTeX_AMS-Regular.woff2`）→ 内容；找不到返回 null（保留原引用、不抛）。
 */
export async function inlineKatexFonts(
  css: string,
  readFont: (name: string) => Promise<Buffer | null>,
): Promise<string> {
  // 先剥后备：woff2 在 src 列表首位，剥掉其后的 woff/ttf 段后，每个 @font-face 只剩 woff2 一条。
  const stripped = css.replace(FALLBACK, '');
  // 收集剩余的 woff2 引用，去重读盘，再整体替换。
  const names = new Set<string>();
  for (const m of stripped.matchAll(FONT_URL)) names.add(m[1]);
  const dataUris = new Map<string, string>();
  for (const name of names) {
    const buf = await readFont(name);
    if (buf) dataUris.set(name, `data:font/woff2;base64,${buf.toString('base64')}`);
  }
  return stripped.replace(FONT_URL, (whole, name) => {
    const uri = dataUris.get(name);
    return uri ? `url(${uri})` : whole;
  });
}

/**
 * 把内联了字体的 katex <style> 注入 HTML 的 </head> 前（缺 </head> 则置于 <body 前兜底，不抛）。
 * HTML 出口与 PDF 出口共用：两者都拿渲染端不含 katex CSS 的 HTML，在此补上自包含数学样式。
 */
export async function injectKatexInto(html: string): Promise<string> {
  const styleTag = await buildKatexStyleTag();
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${styleTag}</head>`);
  if (/<body/i.test(html)) return html.replace(/<body/i, `${styleTag}<body`);
  return styleTag + html;
}

let cached: Promise<string> | undefined;

/**
 * 读真实 node_modules 的 katex.min.css + woff2 字体，产出可直接注入 <head> 的自包含 <style>。
 * 内容是静态的，模块级缓存一次（导出 N 次复用同一份）。
 */
export function buildKatexStyleTag(): Promise<string> {
  cached ??= (async () => {
    const cssPath = require.resolve('katex/dist/katex.min.css');
    const fontsDir = join(dirname(cssPath), 'fonts');
    const css = await readFile(cssPath, 'utf-8');
    const inlined = await inlineKatexFonts(css, (name) =>
      readFile(join(fontsDir, name)).catch(() => null),
    );
    return `<style>${inlined}</style>`;
  })();
  return cached;
}
