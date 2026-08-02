/// <reference lib="dom" />
/**
 * 随手评点（aside）⌥点的 DOM 就地提取——纯函数，零 electron 依赖。
 *
 * 从 deckPreview.ts 拆出来是为了可测：preload 跑在 webview 里没法纯单测，
 * 这里只吃 DOM 输入、吐 AsideDeckClickPayload，vitest + jsdom 直接喂伪文档。
 */
import type { AsideDeckClickPayload } from '@shared/types';

/** 首行文本兜底的截断上限——流式半截/无标题页可能整页是长文本，大纲条目保持短 */
const TITLE_FALLBACK_MAX = 60;

/** innerText 优先（用户看见的渲染文本），jsdom 等无布局环境退 textContent */
function visibleText(el: Element | null): string {
  if (!el) return '';
  return ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
}

/**
 * 从 el 向上找 .slide 容器，返回它在 document 内的 .slide 序号；不在任何 slide 内返回 -1。
 * 认页按 class `.slide`，与 main 侧 segmentSlides / 渲染端翻页同一口径。
 */
export function findPageIndex(el: Element): number {
  let cur: Element | null = el;
  while (cur && !cur.classList?.contains('slide')) cur = cur.parentElement;
  if (!cur) return -1;
  const allSlides = Array.from(el.ownerDocument.querySelectorAll('.slide'));
  return allSlides.indexOf(cur);
}

/**
 * 单页标题口径：首个 h1-h6 的文本；deck 产物没有固定的标题 class，标题元素抓不到时
 * 用该页文本首个非空行兜底（截 60 字）——流式半截页可能两者皆空，返回空串。
 */
function slideTitle(slide: Element): string {
  const heading = visibleText(slide.querySelector('h1, h2, h3, h4, h5, h6'));
  if (heading) return heading;
  const firstLine = visibleText(slide)
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine.length > TITLE_FALLBACK_MAX ? `${firstLine.slice(0, TITLE_FALLBACK_MAX)}…` : firstLine;
}

/**
 * ⌥点真实 target 解析——处理框选 overlay 的遮挡。
 *
 * 框选 overlay 是全屏元素（inset:0），激活时 ⌥点的 e.target 必然是 overlay，
 * findPageIndex 拿它只会得 -1、提取退化成 blank 档。aside 优先顶掉进行中的
 * 模态手势：先 exitFrame 退出框选，overlay 离开命中测试后 elementFromPoint
 * 才能取到点下的真实元素。框选未激活时原样返回 rawTarget，零开销。
 *
 * 时序依据：exitFrame 必须**同步**把 overlay 从命中测试中拿掉（移除 DOM 或
 * pointer-events:none）——现状 deckPreview 的 exitFrameMode 同步 remove DOM，
 * 满足；若未来退出改成异步/带动画，需在调这里之前先把 overlay 置
 * pointer-events:none。
 */
export function resolveAsideTarget(args: {
  doc: Document;
  /** 事件原始 target（框选激活时是 overlay） */
  rawTarget: Element | null;
  /** 点击位置（视口 CSS 像素） */
  x: number;
  y: number;
  /** 框选模式是否激活 */
  frameActive: boolean;
  /** 退出框选——必须同步移除 overlay 的命中测试，见上方时序依据 */
  exitFrame: () => void;
}): Element | null {
  const { doc, rawTarget, x, y, frameActive, exitFrame } = args;
  if (!frameActive) return rawTarget;
  exitFrame();
  return doc.elementFromPoint(x, y);
}

/**
 * 组装 ⌥点上抛 payload。
 * 没命中 .slide（页间留白/容器边缘）也照样组装——payload 只带大纲，
 * "点哪都有反应"是铁律，webview 内不能有死角。
 */
export function buildDeckAsideClickPayload(args: {
  doc: Document;
  /** 点击目标；可能为 null（极端事件形态），按未命中处理 */
  target: Element | null;
  /** 点击时 deck 内文本选区（调用方读 window.getSelection()） */
  selectionText: string;
  /** 点击位置（视口 CSS 像素） */
  x: number;
  y: number;
}): AsideDeckClickPayload {
  const { doc, target, selectionText, x, y } = args;
  const slides = Array.from(doc.querySelectorAll('.slide'));
  const pageIndex = target ? findPageIndex(target) : -1;
  return {
    pageIndex,
    pageText: pageIndex >= 0 ? visibleText(slides[pageIndex]) : '',
    selectionText: selectionText.trim(),
    outline: slides.map(slideTitle),
    x,
    y,
  };
}
