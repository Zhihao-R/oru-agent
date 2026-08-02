/**
 * Deck HTML 导出，两种形态（PRD §各格式的行为）：
 * - 单文件自包含：把本地图片/字体内联成 base64 data URI，输出一个双击即开、不断链的 .html。
 * - 打包 zip：index.html + 素材原样打包，剔除版本历史/批注/草稿/既往导出物。
 *
 * 不引 DOM 解析库：deck 的 HTML 是 Oru 自己生成、结构可控，正则替换足够且零依赖——
 * 与 deckModel.segmentSlides 用正则切页同一判断（系统性）。
 */
import { promises as fs } from 'node:fs';
import { join, extname, basename, relative, isAbsolute } from 'node:path';
import JSZip from 'jszip';
import { exportPath, writeExportAtomic } from './exportCommon';
import { getCanvas } from './deckModel';
import { deckStandaloneRuntime } from './deckFrame';

/** 扩展名 → MIME。未知扩展回退 octet-stream（浏览器多半仍能凭内容嗅探显示）。 */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** 只内联本地相对引用；外链 / 已是 data URI / 锚点不碰。 */
function isLocalRef(ref: string): boolean {
  return !/^(https?:)?\/\//i.test(ref) && !ref.startsWith('data:') && !ref.startsWith('#');
}

/**
 * 把 HTML 里的本地资源引用替换成 base64 data URI。纯函数（IO 经 resolve 注入），便于单测。
 * 覆盖 `src="..."`（img/source/video/script 等）与 CSS `url(...)`（背景图、@font-face 字体）。
 * @param resolve 相对路径 → 文件内容；找不到返回 null（不抛——一个坏引用不该毁掉整次导出）。
 * @returns 替换后的 HTML + 未找到的引用列表（调用方按需提示，不阻断）。
 */
export async function inlineAssets(
  html: string,
  resolve: (ref: string) => Promise<Buffer | null>,
): Promise<{ html: string; missing: string[] }> {
  const missing: string[] = [];
  // 先收集所有待替换引用（src= 与 url()），去重后逐个读盘，再做整体替换——
  // 避免同一图片被多处引用时重复读盘。
  const refs = new Set<string>();
  const SRC = /\bsrc\s*=\s*(['"])([^'"]+)\1/gi;
  const URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  for (const re of [SRC, URL]) {
    for (const m of html.matchAll(re)) {
      const ref = m[2].trim();
      if (isLocalRef(ref)) refs.add(ref);
    }
  }

  const dataUris = new Map<string, string>();
  for (const ref of refs) {
    const buf = await resolve(ref);
    if (buf === null) {
      missing.push(ref);
      continue;
    }
    dataUris.set(ref, `data:${mimeFor(ref)};base64,${buf.toString('base64')}`);
  }

  const out = html
    .replace(SRC, (whole, q, ref) => {
      const uri = dataUris.get(ref.trim());
      return uri ? `src=${q}${uri}${q}` : whole;
    })
    .replace(URL, (whole, q, ref) => {
      const uri = dataUris.get(ref.trim());
      return uri ? `url(${q}${uri}${q})` : whole;
    });
  return { html: out, missing };
}

/**
 * 给导出物注入自包含播放 runtime —— 分发态(导出)专属,预览态由 Oru 托管不注入。
 * 源文件按托管契约只写内容(无缩放翻页),这里补上脱离 Oru 也能播放的缩放/翻页(deckFrame 单一真相源)。
 * 注入在 </body> 前;缺 </body> 则附末尾(容错,不抛)。
 */
function injectStandaloneRuntime(html: string): string {
  const { width, height } = getCanvas(html);
  const runtime = deckStandaloneRuntime(width, height);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${runtime}\n</body>`) : `${html}\n${runtime}`;
}

export async function exportDeckToInlineHtml(deckPath: string): Promise<string> {
  const indexHtml = await fs.readFile(join(deckPath, 'index.html'), 'utf-8');
  const { html, missing } = await inlineAssets(indexHtml, async (ref) => {
    // 相对 deck 目录解析；越界路径（../ 或绝对路径）按找不到处理，不读 deck 外的文件。
    // 用 relative 判断而非 startsWith(deckPath)——后者会被同前缀兄弟目录（贡嘎 / 贡嘎-bak）绕过。
    const abs = join(deckPath, ref);
    const rel = relative(deckPath, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return fs.readFile(abs).catch(() => null);
  });
  if (missing.length > 0) {
    // 不阻断：缺的引用保持原样，导出仍产出（PRD：一个坏引用不毁整次导出）
    console.warn(`[exportHtml] ${missing.length} 个本地资源未找到，保持原引用:`, missing);
  }
  const out = await exportPath(deckPath, 'html');
  await writeExportAtomic(out, injectStandaloneRuntime(html));
  return out;
}

/**
 * zip 打包是否收录某个 deck 目录项。剔除：点开头隐藏项（.history/.annotations.json/
 * .narrative.md/.*.tmp）与既往导出物（<名>.html/.pdf/.pptx/.zip）——只带"打开演示稿需要的东西"。
 * 纯函数，单测覆盖。
 */
export function shouldIncludeInZip(name: string, deckBaseName: string): boolean {
  if (name.startsWith('.')) return false;
  const exports = new Set(['html', 'pdf', 'pptx', 'zip'].map((ext) => `${deckBaseName}.${ext}`));
  return !exports.has(name);
}

/** 递归把 dir 下应收录的文件加进 zip（zipDir 为 zip 内相对目录）。 */
async function addDirToZip(zip: JSZip, dir: string, deckRoot: string, zipDir = ''): Promise<void> {
  const deckBaseName = basename(deckRoot);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    if (!shouldIncludeInZip(ent.name, deckBaseName)) continue;
    const abs = join(dir, ent.name);
    const zipPath = zipDir ? `${zipDir}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      await addDirToZip(zip, abs, deckRoot, zipPath);
    } else if (ent.isFile()) {
      // 顶层 index.html 注入分发态 runtime,使解压后双击即可独立播放;其余文件原样打包
      if (zipPath === 'index.html') {
        zip.file(zipPath, injectStandaloneRuntime(await fs.readFile(abs, 'utf-8')));
      } else {
        zip.file(zipPath, await fs.readFile(abs));
      }
    }
  }
}

export async function exportDeckToZip(deckPath: string): Promise<string> {
  const zip = new JSZip();
  // zip 内根目录直接是 index.html（不嵌一层目录，解压即用）
  await addDirToZip(zip, deckPath, deckPath);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const out = await exportPath(deckPath, 'zip');
  await writeExportAtomic(out, buf);
  return out;
}
