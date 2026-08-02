/**
 * Deck 客观校验器（任务 7 第一段）——把渲染/分页/导出会真正出问题的低级硬伤确定性地查出来。
 *
 * 只查"确定性可判、且几乎一定是错"的四类客观硬伤（PRD 定的口径：宁缺毋滥、优先准）：
 *  1. structure  —— 一个 slide 都分不出来 / index.html 缺失或为空（分页结构垮了，整条 deck 链失效）
 *  2. broken-image —— 引用了本地 images/xxx 但文件不在（渲染出来就是裂图框）
 *  3. overflow   —— 某页内容超出 deck 声明画布的页框（标题被切、内容掉出可视区）
 *  4. blank      —— 整页渲染近乎全白（大概率漏写内容或结构出错）
 *
 * 静态查（读文件 + 正则）结构与失效图；渲染查（离屏窗口量度）溢出与空白。渲染量度复用 render 层
 * 的 withOffscreenPage（离屏窗口生命周期只此一份），拆页/拆头体复用 slideUtils / contactSheet。
 * 返 DeckValidationError[]，启动期 registerDeckValidator() 经 setValidateDeckImpl 接入。
 *
 * 本模块不卡模型——它只负责"睁眼看见 + 回喂"，修不修、收不收工是模型的判断（见 subagentRunner
 * 的建议式回路）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { segmentSlides, getCanvas, type DeckCanvas } from './deckModel';
import { extractHeadAndBody, assembleStandalonePage } from './contactSheet';
import { deckIndexPath, deckImagesDir } from './pathResolver';
import { withOffscreenPage, isNearWhite } from '../render/htmlRenderer';
import { setValidateDeckImpl, type DeckValidator, type DeckValidationError } from './validateDeck';

/** 溢出容差：任一维度超出页框这么多像素才算溢出，挡亚像素 / 滚动条假阳。 */
const OVERFLOW_TOL = 4;

/**
 * 测量专用归一化（决策 2 + M1）：中和可见性 + 把 .slide 置为 position:relative + **钉到声明画布尺寸**。
 *
 * 不复用 contactSheet 的 NORMALIZE_CSS（它含 position:static）——deck 常用绝对定位叠放各页、
 * 页内子元素又相对 .slide 绝对定位；强制 static 会改变绝对定位子元素的包含块（上溯到外层定位
 * 祖先 / 视口），它们的溢出不再计入 .slide.scrollHeight → 漏判。relative 让 .slide 既在流内
 * （进视口可测）、又仍是绝对定位子元素的包含块，溢出计数与真实渲染一致。不动 inset/transform。
 *
 * width/height 钉到声明画布（M1）：溢出探针量的是 scrollW/H 超出 clientW/H，client 由 .slide 自身
 * CSS 决定。对固定 px 页（`.slide{width:1920px}` 这类），只改渲染视口 client 仍是声明的 px、按错
 * 画框判；显式把 .slide 钉到画布尺寸，溢出恒对真实画框判，与页内用 vw/vh 还是 px 无关。
 */
function measureNormalizeCss(canvas: DeckCanvas): string {
  return (
    `.slide{display:block!important;opacity:1!important;visibility:visible!important;` +
    `position:relative!important;width:${canvas.width}px!important;height:${canvas.height}px!important}`
  );
}

/**
 * 溢出探针——在渲染进程量 .slide 自身的 scrollW/H 超出 clientW/H（即使被 overflow:hidden 裁切也照算，
 * 这是唯一同时覆盖"撑高型"和"被裁型"溢出的确定性信号）。
 *
 * 是**裸表达式字符串**、不是 fn.toString()：避免 esbuild 给具名内层函数注 __name 致渲染进程崩
 * （记忆 project_electron_eval_fn_no_named_inner）。匿名箭头 IIFE 安全。
 */
const OVERFLOW_PROBE = `(() => {
  const s = document.querySelector('.slide');
  if (!s) return [0, 0];
  return [s.scrollWidth - s.clientWidth, s.scrollHeight - s.clientHeight];
})()`;

/**
 * 抽 images/ 引用的纯逻辑（history.ts 也用——不并存两份正则，系统性）。
 * 去掉 querystring/fragment（`?#` 之后）：模型可能手写 `src="images/x.png?v=1"`，而落盘文件名是
 * `x.png`（download_image 存盘时剥过 query）——去掉才能正确比对存在性。
 */
export function extractImageRefs(html: string): string[] {
  const re = /(?:src|href)\s*=\s*["'](images\/[^"']+)["']/gi;
  const refs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    refs.add(m[1].replace(/[?#].*$/, ''));
  }
  return [...refs];
}

/**
 * 检测 body 内"在所有 .slide 块之外的非空可见文本"（§四 部分认不出兜底）。
 *
 * 切页是正则、非 DOM，认不出的内容因为没被解析成页，**无法点名第几页**（诚实边界）——能可靠做到的
 * 只是"提示存在未识别为页的内容"。判据用**可见文本**（最可靠的信号）：从 body 里抠掉所有已识别 slide
 * 块、再剥掉 script/style/template/noscript/svg/注释（不渲染成可见文字的），剩余纯文本去空白后
 * ≥ 阈值即判存在。纯装饰 chrome（.deck 容器 / 进度条 / 脚本）无可见文字 → 不误报正常 deck；纯图片的
 * 未识别页文字少可能漏报——这是已声明的限度，不为它过度堆探针。
 */
// 经验阈值（非推导值）：低于约这个量级的残留多是没抠净的装饰 chrome 文字，高于则基本是真内容。
// 取偏保守的 40 以免误报正常 deck；纯图/极短的未识别页文字不足会漏报——这是已声明的限度。
const UNRECOGNIZED_TEXT_MIN = 40;

export function hasUnrecognizedContent(html: string, slides: string[]): boolean {
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let rest = bodyMatch ? bodyMatch[1] : html;
  // 用 split/join 而非 replace(string)——后者只替首次匹配，两页 HTML 完全相同（同模板空页）时
  // 第二页不会被抹掉、其文字会被误判成"未识别内容"。split/join 抹掉全部出现。
  for (const slide of slides) rest = rest.split(slide).join(' ');
  rest = rest
    .replace(/<(script|style|template|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const text = rest.replace(/\s+/g, ' ').trim();
  return text.length >= UNRECOGNIZED_TEXT_MIN;
}

/** 把溢出像素描述成可读短语（只报超出的维度），供回喂清单 message 用。 */
export function describeOverflow(px: { x: number; y: number }): string {
  const parts: string[] = [];
  if (px.y > 0) parts.push(`竖向溢出 ${Math.round(px.y)}px`);
  if (px.x > 0) parts.push(`横向溢出 ${Math.round(px.x)}px`);
  return parts.join('、') || '内容超出页框';
}

/** 读 index.html；缺失 / 空（trim 后无内容）→ null。 */
async function readIndexHtml(deckPath: string): Promise<string | null> {
  try {
    const html = await fs.readFile(deckIndexPath(deckPath), 'utf-8');
    return html.trim().length === 0 ? null : html;
  } catch {
    return null;
  }
}

/** 本地 images/ 引用是否存在（ref 已去 querystring）。 */
async function imageExists(deckPath: string, ref: string): Promise<boolean> {
  const rel = ref.replace(/^images\//, '');
  try {
    await fs.access(join(deckImagesDir(deckPath), rel));
    return true;
  } catch {
    return false;
  }
}

/**
 * 渲染单页一次，同时拿溢出 + 空白两个度量（共用一次渲染）：
 *  - 溢出：OVERFLOW_PROBE 量 .slide scrollW/H 超出 clientW/H
 *  - 空白：满 viewport 截图（CDP）喂 isNearWhite
 * 借 render 层 withOffscreenPage 管窗口生命周期，deck 语义留在 deck 层；组装复用 contactSheet 的
 * assembleStandalonePage（只换测量专用归一化 CSS，骨架不另造一份）。
 */
async function measureSlide(
  head: string,
  bodyOpenTag: string,
  slideHtml: string,
  deckPath: string,
  canvas: DeckCanvas,
  signal?: AbortSignal,
): Promise<{ overflowPx: { x: number; y: number }; isBlank: boolean }> {
  const standalone = assembleStandalonePage(head, bodyOpenTag, slideHtml, measureNormalizeCss(canvas));
  return withOffscreenPage(
    { source: { kind: 'inline', html: standalone, baseDir: deckPath }, viewport: canvas, signal },
    async ({ webContents, guard, capture }) => {
      const [x, y] = (await guard(webContents.executeJavaScript(OVERFLOW_PROBE), '溢出测量超时')) as [
        number,
        number,
      ];
      const img = await capture();
      if (img.isEmpty()) return { overflowPx: { x, y }, isBlank: true }; // 截不出 = 视觉空白
      return { overflowPx: { x, y }, isBlank: isNearWhite(img) };
    },
  );
}

/** Deck 客观校验器真实现（接入 setValidateDeckImpl）。signal：取消任务时透传，逐页渲染随之中止。 */
export const deckValidator: DeckValidator = async (deckPath, signal) => {
  const html = await readIndexHtml(deckPath);
  if (html == null) return [{ page: null, kind: 'structure', message: 'index.html 缺失或为空' }];
  const slides = segmentSlides(html);
  if (slides.length === 0) {
    return [
      {
        page: null,
        kind: 'structure',
        message: '未识别出任何分页（每页需是一个带 class="slide" 的块，标签可为 section/div/article）',
      },
    ];
  }

  const canvas = getCanvas(html);
  const { head, bodyOpenTag } = extractHeadAndBody(html);
  const errors: DeckValidationError[] = [];
  // 部分认不出（§四）：识别到 N 页、但 body 里还有 .slide 之外的可见文本——如实提示，无法点名第几页。
  if (hasUnrecognizedContent(html, slides)) {
    errors.push({
      page: null,
      kind: 'unrecognized',
      message: `识别到 ${slides.length} 页，另有未被识别为页的内容（无法定位具体页，未纳入逐页复查）`,
    });
  }
  // 逐页独立渲染（与 contactSheet 同量级，决策 8：先最简正确，实测卡再上单窗口复用）
  for (let i = 0; i < slides.length; i += 1) {
    const page = i + 1;
    // 静态：失效图
    for (const ref of extractImageRefs(slides[i])) {
      if (!(await imageExists(deckPath, ref))) {
        errors.push({ page, kind: 'broken-image', message: `引用的图片不存在：${ref}` });
      }
    }
    // 渲染：溢出 + 空白（一次渲染两度量）。blank 与 overflow 互斥优先——空页无"内容溢出"语义。
    const m = await measureSlide(head, bodyOpenTag, slides[i], deckPath, canvas, signal);
    if (m.isBlank) {
      errors.push({ page, kind: 'blank', message: '整页渲染近乎全白（可能漏写内容或结构出错）' });
    } else if (m.overflowPx.x > OVERFLOW_TOL || m.overflowPx.y > OVERFLOW_TOL) {
      errors.push({ page, kind: 'overflow', message: `内容超出页框（${describeOverflow(m.overflowPx)}）` });
    }
  }
  return errors;
};

/** 启动期接入真实校验器（index.ts 调，与 registerBuiltinCapabilities 平行）。 */
export function registerDeckValidator(): void {
  setValidateDeckImpl(deckValidator);
}
