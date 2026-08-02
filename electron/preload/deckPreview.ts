/// <reference lib="dom" />
/**
 * Deck 预览 webview 内的 preload script
 *
 * 跟主窗口 preload (`index.ts`) 分离——webview 是独立 webContents，preload 通过
 * `<webview preload="...">` 属性加载。Electron 41 + contextIsolation=true 下走
 * CJS 加载器（详 electron.vite.config.ts），所以这个文件编译为 deckPreview.cjs。
 *
 * 当前职责：
 * - 右键文字 →「编辑文字」菜单 → contentEditable + Enter/blur 保存 → sendToHost('inline:edited')；
 *   写回失败时 host 回三种事件之一，都回滚未落盘 DOM，但文案不同：
 *   'inline:editRejected'（定位降级）→"用框选交给 AI 改"、'inline:editConflict'（文件被外部改）→"请刷新"、
 *   'inline:editFailed'（io/超时等临时失败）→"请重试"
 * - 键盘 ←/→/F/Esc/⌘Z → sendToHost('key:nav' / 'key:chrome' / 'key:escape' / 'key:undo')
 * - 离散翻页：oru:setPage 切 [data-oru-active]
 * - 设计稿缩放：oru:setDeckScale 应用 body transform
 * - DOMContentLoaded 后推 oru:deckMeta（设计稿尺寸 + slide 总数）给 host
 * - 框选捕获：frame:enter 盖 overlay 画选框 + hit-test → frame:captured 带快照 + 坐标给 host
 * - 随手评点：⌥点就地提取 DOM（命中页/选区/大纲）→ sendToHost('aside:clicked')，
 *   同时吞掉行内编辑/框选/链接等后续手势（aside 优先）
 *
 * **不**实现：元素级 click marker / 多选 outline / 角标——v2 注释改为页级，元素 marker 已废。
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ipcRenderer } = require('electron');

// 画布解析与 main 侧共用同一份纯函数（deckModel 零 node 依赖，编译时内联进 deckPreview.cjs）——
// 认页/取尺寸口径 main 与渲染端必须一致，否则标注 pageIndex 会两侧错位。
import { parseDeckSizeContent, DEFAULT_CANVAS } from '../main/deck/deckModel';
// 画布骨架(定尺/显隐)与导出态共用同一份——预览注入、导出内联,两端不并存两套
import { deckFrameCss } from '../main/deck/deckFrame';
// 随手评点（aside）⌥点的 DOM 提取——纯函数拆在独立模块里可单测（jsdom）
import { buildDeckAsideClickPayload, findPageIndex, resolveAsideTarget } from './deckAsideExtract';

/**
 * 注入 Oru 行内编辑视觉样式。
 * - data-oru-editing：右键菜单进入行内编辑（橙色虚线 outline + "✎ 编辑中"）
 */
function injectOruStyles() {
  const style = document.createElement('style');
  style.setAttribute('data-oru-style', '1');
  style.textContent = `
    [data-oru-editing] {
      outline: 2px dashed #F57C00 !important;
      outline-offset: 3px !important;
      background-color: rgba(245, 124, 0, 0.06) !important;
      position: relative !important;
    }
    [data-oru-editing]::before {
      content: '✎ 编辑中 · Enter 保存 · Esc 取消';
      position: absolute;
      top: -22px;
      left: 0;
      padding: 2px 6px;
      border-radius: 4px;
      background: #F57C00;
      color: #fff;
      font: 600 10px/14px -apple-system, BlinkMacSystemFont, sans-serif;
      white-space: nowrap;
      pointer-events: none;
      z-index: 9999;
    }
  `;
  document.head.appendChild(style);
}

/**
 * 离散翻页：所有 slide `display: none`，只有 `[data-oru-active]` 一张 `display: flex`。
 * 当前页 state 由 host 持有（避免双 source of truth），preload 只接收 host 指令切换。
 */
function setActivePage(idx: number) {
  const slides = document.querySelectorAll<HTMLElement>('.slide');
  if (slides.length === 0) return;
  const clamped = Math.max(0, Math.min(idx, slides.length - 1));
  slides.forEach((s, i) => {
    if (i === clamped) s.setAttribute('data-oru-active', '1');
    else s.removeAttribute('data-oru-active');
  });
}

ipcRenderer.on('oru:setPage', (_evt: unknown, idx: number) => {
  setActivePage(idx);
});

// host → preload：plain 制品按标注 scrollY 平滑滚动到位（AnnotPane 点卡片跳转）
ipcRenderer.on('oru:scrollTo', (_evt: unknown, y: number) => {
  window.scrollTo({ top: y, behavior: 'smooth' });
});

/**
 * 找最近"语义边界"元素——从 click target 向上爬，命中 article/section/h1-h6/li/img/p/figure/blockquote/td 即停。
 * 避免命中 .slide 容器或 body/html 这类太宏的元素。
 */
function pickEditableTarget(el: Element | null): Element | null {
  const SEMANTIC = new Set(['ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'IMG', 'P', 'FIGURE', 'BLOCKQUOTE', 'TD', 'BUTTON', 'A']);
  const BOUNDARY = new Set(['BODY', 'HTML']);
  let cur: Element | null = el;
  while (cur && !BOUNDARY.has(cur.tagName)) {
    if (cur.classList.contains('slide')) return null;     // 不让用户标整页 slide 容器
    if (SEMANTIC.has(cur.tagName)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

// 已发往 host、尚未确认落盘的编辑——host 回 'inline:editRejected' 时据此回滚 DOM。
// 只保留最近一笔：行内编辑是同步串行交互（一次只编辑一个元素），不会有并发待确认。
let pendingEdit: { el: Element; originalHtml: string } | null = null;

/** 在元素附近弹一个短暂提示浮层（克制：纯 DOM、无动效库、1.5s 后移除）。 */
function showRejectToast(el: Element, text = '这块用框选交给 AI 改') {
  const r = el.getBoundingClientRect();
  const tip = document.createElement('div');
  tip.textContent = text;
  // all:initial 先重置——隔离宿主页面（可能是任意外部 HTML）的 div/* 全局规则，避免浮层被污染
  tip.style.cssText =
    'all:initial; position:fixed; z-index:2147483647; padding:6px 10px; border-radius:6px; ' +
    'background:#323232; color:#fff; font:600 12px/16px -apple-system,BlinkMacSystemFont,sans-serif; ' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.25); pointer-events:none; white-space:nowrap;';
  tip.style.left = `${Math.max(8, r.left)}px`;
  tip.style.top = `${Math.max(8, r.top - 30)}px`;
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 1500);
}

// host → preload：后端定位降级，回滚 DOM 未落盘的编辑 + 提示
ipcRenderer.on('inline:editRejected', () => {
  if (!pendingEdit) return;
  const { el, originalHtml } = pendingEdit;
  el.innerHTML = originalHtml;
  showRejectToast(el);
  pendingEdit = null;
});

// host → preload：基线失配（文件被外部改过），同样回滚未落盘编辑——DOM 不能领先磁盘——但提示文案不同
ipcRenderer.on('inline:editConflict', () => {
  if (!pendingEdit) return;
  const { el, originalHtml } = pendingEdit;
  el.innerHTML = originalHtml;
  showRejectToast(el, '文件已变，请刷新后再改');
  pendingEdit = null;
});

// host → preload：io/超时/断连等临时失败——同样回滚（DOM 不能领先磁盘），但这不是定位降级，
// 文案是"请重试"而非"框选交给 AI 改"（后者会误导用户以为定位不到）。三类失败三种文案：
// degraded→框选 / conflict→刷新 / io 类→重试。纯增量事件，deck 当前不发它（PreviewPane 对 io 不回滚）。
ipcRenderer.on('inline:editFailed', () => {
  if (!pendingEdit) return;
  const { el, originalHtml } = pendingEdit;
  el.innerHTML = originalHtml;
  showRejectToast(el, '保存失败，请重试');
  pendingEdit = null;
});

/**
 * 让 target 进入行内编辑（contentEditable）——commit 发 'inline:edited' 给 host，
 * Enter 保存 / Esc 取消 / blur（点别处）保存。从右键菜单「编辑文字」进入，行为与旧双击进入一致。
 */
function enterInlineEdit(target: Element) {
  // 快路径 markerId：仅当元素**本来就带** data-edit-id（Oru 自产、源里有）才传；
  // 编辑前读，不现场生成 m-xxx（源里没有、对外部静态 HTML 无用）。外部 HTML 走后端 oldText 定位。
  const existingId = target.getAttribute('data-edit-id');
  const originalHtml = target.innerHTML;
  const pageIndex = findPageIndex(target);

  target.setAttribute('data-oru-editing', '1');
  target.setAttribute('contenteditable', 'true');
  (target as HTMLElement).focus();

  let saved = false;
  const cleanup = () => {
    target.removeAttribute('contenteditable');
    target.removeAttribute('data-oru-editing');
    target.removeEventListener('blur', commit);
    target.removeEventListener('keydown', onKey);
  };
  const commit = () => {
    if (saved) return;
    saved = true;
    cleanup();
    if (target.innerHTML !== originalHtml) {
      // 记下待确认编辑——被拒时 host 回 'inline:editRejected' 据此回滚
      pendingEdit = { el: target, originalHtml };
      ipcRenderer.sendToHost('inline:edited', {
        markerId: existingId ?? null,
        oldText: originalHtml,
        newText: target.innerHTML,
        pageIndex,
      });
    }
  };
  const cancel = () => {
    if (saved) return;
    saved = true;
    target.innerHTML = originalHtml;
    cleanup();
  };
  const onKey = (ev: Event) => {
    const k = ev as KeyboardEvent;
    if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); commit(); }
    if (k.key === 'Escape') { k.preventDefault(); cancel(); }
  };
  target.addEventListener('blur', commit, { once: true });
  target.addEventListener('keydown', onKey);
}

// 当前打开的右键菜单（DOM 节点 + 配对清理）。同一时刻只允许一个——再次右键先关旧的。
let openContextMenu: { remove: () => void } | null = null;

/**
 * 在鼠标处弹一个极简菜单（仅「编辑文字」一项）。
 * 副作用全收在返回的 remove 里：移除菜单节点 + 摘掉为关菜单加的 document 监听（与注册同处可见）。
 */
function showEditMenu(clientX: number, clientY: number, target: Element) {
  const menu = document.createElement('div');
  // all:initial 先重置——隔离宿主页面（可能是任意外部 HTML）的全局规则，避免菜单被污染
  menu.style.cssText =
    'all:initial; position:fixed; z-index:2147483647; min-width:96px; padding:4px; ' +
    'border-radius:8px; background:#fff; box-shadow:0 4px 16px rgba(0,0,0,0.18); ' +
    'border:1px solid rgba(0,0,0,0.08);';
  // 越界下钳：与 showRejectToast 同口径（min 8px），避免贴边右键时菜单左/上溢出视口
  menu.style.left = `${Math.max(8, clientX)}px`;
  menu.style.top = `${Math.max(8, clientY)}px`;

  const item = document.createElement('div');
  item.textContent = '编辑文字';
  item.style.cssText =
    'all:initial; display:block; padding:6px 12px; border-radius:5px; cursor:pointer; ' +
    'font:500 13px/18px -apple-system,BlinkMacSystemFont,sans-serif; color:#1a1a1a; white-space:nowrap;';
  item.addEventListener('mouseenter', () => { item.style.background = '#f0f0f0'; });
  item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
  menu.appendChild(item);
  document.body.appendChild(menu);

  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
    openContextMenu = null;
  };
  // 点菜单外 / Esc 关菜单（不进入编辑）
  const onOutside = (ev: Event) => { if (!menu.contains(ev.target as Node)) close(); };
  // stopPropagation 挡住后续 bubble：否则关菜单的 Esc 会冒泡到 bindKeyboard 被误当退出预览上报 host
  const onEsc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onEsc, true);

  item.addEventListener('click', () => {
    close();
    enterInlineEdit(target);
  });

  openContextMenu = { remove: close };
}

function bindContextMenuEdit() {
  document.addEventListener('contextmenu', (e) => {
    // 一个菜单同一时刻只允许一个——再次右键先关旧的
    openContextMenu?.remove();
    const target = pickEditableTarget(e.target as Element | null);
    // 未命中（空白 / 图片 / 按钮）→ 不拦截，放行浏览器默认右键菜单
    if (!target || target.tagName === 'IMG' || target.tagName === 'BUTTON') return;
    e.preventDefault();
    showEditMenu(e.clientX, e.clientY, target);
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    // 行内编辑时（contentEditable）→ 让原生处理 Enter/Esc，preload 不抢
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.isContentEditable) return;

    // 翻页：webview 内按箭头时上报给 host；host 持有 currentPage state、负责派发回 oru:setPage
    if (e.key === 'ArrowLeft') { e.preventDefault(); ipcRenderer.sendToHost('key:nav', { dir: 'prev' }); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); ipcRenderer.sendToHost('key:nav', { dir: 'next' }); }
    else if (e.key === 'f' || e.key === 'F') { ipcRenderer.sendToHost('key:chrome', {}); }
    else if (e.key === 'Escape') { ipcRenderer.sendToHost('key:escape', {}); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      ipcRenderer.sendToHost(e.shiftKey ? 'key:redo' : 'key:undo', {});
    }
  });

  // 滚轮翻页：仅 deck（有分页、overflow:hidden 不滚动）拦截——一次滚动翻一页，350ms 冷却避免
  // 触控板连续 delta 一下翻好几页。plain（无 .slide）不拦，让页面原生滚动。
  let wheelCooldownUntil = 0;
  document.addEventListener('wheel', (e) => {
    if (document.querySelectorAll('.slide').length === 0) return;
    const ae = document.activeElement as HTMLElement | null;
    if (ae?.isContentEditable) return;
    // 只拦竖向主导的滚动（翻页意图）；水平滚动不拦，别误吞触控板横划
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    const now = Date.now();
    if (now < wheelCooldownUntil || Math.abs(e.deltaY) < 4) return;
    wheelCooldownUntil = now + 350;
    ipcRenderer.sendToHost('key:nav', { dir: e.deltaY > 0 ? 'next' : 'prev' });
  }, { passive: false });
}

// ─── 随手评点（aside）⌥点 ────────────────────────────────────────────────
//
// 主窗口的 DOM 事件够不到 webview 内部，"点哪都有反应"在这里兜底。
// 与主窗口侧（src/aside/useAsideAltClick.ts）同一套吞断模型（技术方案 §3.1 的 webview 版）：
// - mousedown（capture）按 `altKey && 左键` 置/清标记；标记为真时就地提取 DOM 上抛，
//   并 preventDefault 保住点击前的文本选区（浏览器在 mousedown 默认行为里清选区）。
// - click / dblclick（capture）只查标记不清标记——吞掉链接跳转 / React onClick / 行内编辑；
//   `e.detail === 0`（键盘激活 / programmatic click）放行，没有 mousedown 前导不该被滞留标记误吞。
// - 标记生命周期完全由 mousedown 管：⌥连点两下 click₁/click₂/dblclick 全吞，下一次普通按下自然清零。
// 监听挂 document、随页面生命周期存亡（与本文件其余绑定同口径），无需显式清理。
let asideSwallow = false;

function bindAsideAltClick() {
  document.addEventListener(
    'mousedown',
    (e) => {
      asideSwallow = e.altKey && e.button === 0;
      if (!asideSwallow) return;
      e.preventDefault();
      // 框选模式激活时 aside 优先顶掉进行中的模态手势：先退出框选再解析真实 target。
      // 时序依据：exitFrameMode 同步 remove overlay/box（无异步无动画），退出后
      // elementFromPoint 即可命中 overlay 底下的真实元素——否则全屏 overlay 让
      // e.target 必然是它自己，提取退化成 blank 档（详 resolveAsideTarget 注释）。
      const target = resolveAsideTarget({
        doc: document,
        rawTarget: e.target instanceof Element ? e.target : null,
        x: e.clientX,
        y: e.clientY,
        frameActive,
        exitFrame: exitFrameMode,
      });
      const payload = buildDeckAsideClickPayload({
        doc: document,
        target,
        selectionText: window.getSelection()?.toString() ?? '',
        // 视口 CSS 像素 = webview 可视坐标（坐标模型见框选一节注释），host 直接可用
        x: e.clientX,
        y: e.clientY,
      });
      ipcRenderer.sendToHost('aside:clicked', payload);
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (asideSwallow && e.detail !== 0) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  document.addEventListener(
    'dblclick',
    (e) => {
      // e.detail === 0（键盘激活 / programmatic）放行——与 click 的豁免对称
      if (asideSwallow && e.detail !== 0) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}

// ─── 框选捕获（frame select）─────────────────────────────────────────────
//
// 交互：host 发 frame:enter → preload 盖全屏 overlay（只拦指针、不动页面 DOM）→
// 用户 mousedown→move→up 画选框 + 吸附高亮命中元素 → 松手算最小覆盖集、拼快照、
// 发 frame:captured 给 host（host 负责 capturePage 截图 + 落标注）→ 自动退出。
//
// 坐标模型（关键）：
//   element.getBoundingClientRect() 返回的是 **应用了 body transform: scale 之后** 的
//   视口 CSS 像素坐标。而 webview 自身的像素尺寸 = 设计稿尺寸 × scale（host 的 stageBox），
//   两者同一坐标系——所以「视口 rect」直接就是「webview 可视坐标」，capturePage 可直接吃。
//   · deck（有 scale）：视口坐标已含 ×scale，无需再乘。
//   · plain（scale=1，但可滚动）：getBoundingClientRect 是相对视口的，capturePage 截可视区，
//     坐标系一致；若选区不在视口，捕获前先 scrollIntoView 再取一次 rect。
//   · rect 一律用 CSS 像素（DIP），**不乘 devicePixelRatio**——capturePage(rect) 吃 DIP，
//     toPNG 产物自动按 dpr 放大。

type FrameRect = { x: number; y: number; w: number; h: number };

let frameActive = false;
let frameCleanup: (() => void) | null = null;

// 命中候选元素的标签：跳过这些容器/不可见/装饰元素，避免命中 body/html/script
const FRAME_SKIP = new Set(['HTML', 'BODY', 'SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'BR']);

/** 矩形相交判定（视口 CSS 像素坐标系）。 */
function rectsIntersect(a: DOMRect, sel: FrameRect): boolean {
  return !(a.right < sel.x || a.left > sel.x + sel.w || a.bottom < sel.y || a.top > sel.y + sel.h);
}

/** sel 完整包含元素 rect（叶子优先判定用）。 */
function rectContains(sel: FrameRect, a: DOMRect): boolean {
  return a.left >= sel.x && a.top >= sel.y && a.right <= sel.x + sel.w && a.bottom <= sel.y + sel.h;
}

/**
 * 最小覆盖集：
 * 1. 收集与选框相交、且自身有可见尺寸的候选元素（排除 overlay 自己和容器标签）。
 * 2. 若存在「被选框完整包含的叶子」（无相交子元素），取这些叶子——最精准。
 * 3. 否则取相交元素里「最浅的块级祖先集合」（剔除掉是别人后代的元素），避免重复嵌套。
 */
function pickHitElements(sel: FrameRect, overlay: HTMLElement): HTMLElement[] {
  const all = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter((el) => {
    if (el === overlay || overlay.contains(el)) return false;
    if (FRAME_SKIP.has(el.tagName)) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return rectsIntersect(r, sel);
  });
  if (all.length === 0) return [];

  // 完全被包含的叶子（这些元素内部没有同样被包含的后代）——最精准的最小集
  const contained = all.filter((el) => rectContains(sel, el.getBoundingClientRect()));
  const leaves = contained.filter((el) => !contained.some((other) => other !== el && el.contains(other)));
  if (leaves.length > 0) return leaves;

  // 否则降级：取相交集合里「最浅祖先」——剔除掉是集合内其他元素后代的元素
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
}

const SNIPPET_MAX = 8 * 1024; // htmlSnippet 截断上限 8KB

/** 给命中元素算宽松 nth-of-type 选择器路径（尽力而为定位用，可空）。 */
function buildSelector(el: HTMLElement): string {
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
    const tag = cur.tagName.toLowerCase();
    const parentEl: HTMLElement | null = cur.parentElement;
    if (!parentEl) { parts.unshift(tag); break; }
    const node: HTMLElement = cur;
    const sameTag = Array.from(parentEl.children).filter((c): c is Element => c.tagName === node.tagName);
    const idx = sameTag.indexOf(node);
    parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx + 1})` : tag);
    cur = parentEl;
  }
  return parts.join(' > ');
}

/** 把命中元素拼成 frame:captured 的 payload。 */
function buildCapturePayload(hits: HTMLElement[], sel: FrameRect) {
  // htmlSnippet：命中元素 outerHTML 拼接，≤8KB 截断附 …
  let htmlSnippet = '';
  let text = '';
  for (const el of hits) {
    htmlSnippet += el.outerHTML;
    const t = (el.innerText ?? el.textContent ?? '').trim();
    if (t) text += (text ? '\n' : '') + t;
  }
  if (htmlSnippet.length > SNIPPET_MAX) htmlSnippet = htmlSnippet.slice(0, SNIPPET_MAX) + '…';

  const pageIndex = hits.length > 0 ? findPageIndex(hits[0]) : -1;
  const selector = hits.length > 0 ? buildSelector(hits[0]) : '';

  const locator: {
    scrollY: number;
    rect: FrameRect;
    pageIndex?: number;
    selector?: string;
  } = {
    scrollY: window.scrollY,
    rect: sel,
  };
  if (pageIndex >= 0) locator.pageIndex = pageIndex;
  if (selector) locator.selector = selector;

  return { htmlSnippet, text, locator };
}

function enterFrameMode() {
  if (frameActive) return;
  frameActive = true;

  // 全屏 overlay：只拦指针，不改/不销毁页面 DOM（弹窗/hover 态原样保留）
  const overlay = document.createElement('div');
  overlay.setAttribute('data-oru-frame-overlay', '1');
  overlay.style.cssText =
    'position:fixed; inset:0; z-index:2147483647; cursor:crosshair; background:transparent;';

  // 跟随选框（视觉反馈）。纯矩形框选——不做元素吸附高亮（用户反馈吸附"很奇怪"且问题多）。
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed; border:1.5px solid #F57C00; background:rgba(245,124,0,0.08); ' +
    'pointer-events:none; display:none; z-index:2147483647;';

  // 挂到 documentElement（<html>，无 transform）而非 body——deck 的 body 带 transform:scale，
  // fixed 子元素会落在缩放坐标系里导致选框与光标错位（用户反馈"鼠标不在框右下角顶点"）。
  // 挂在未缩放的 documentElement 上，box.left=clientX 才正好落在视口光标处。
  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(box);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  // 当前选框（视口 CSS 像素）
  const selRectOf = (cx: number, cy: number): FrameRect => ({
    x: Math.min(startX, cx),
    y: Math.min(startY, cy),
    w: Math.abs(cx - startX),
    h: Math.abs(cy - startY),
  });

  const onDown = (e: MouseEvent) => {
    // ⌥ 按住的按下属于随手评点（aside），不起手框选——让 aside 的 document 级监听接管
    if (e.altKey) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.left = `${startX}px`;
    box.style.top = `${startY}px`;
    box.style.width = '0px';
    box.style.height = '0px';
    box.style.display = 'block';
  };

  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const sel = selRectOf(e.clientX, e.clientY);
    box.style.left = `${sel.x}px`;
    box.style.top = `${sel.y}px`;
    box.style.width = `${sel.w}px`;
    box.style.height = `${sel.h}px`;
  };

  const onUp = (e: MouseEvent) => {
    if (!dragging) return;
    dragging = false;
    const sel = selRectOf(e.clientX, e.clientY);
    // 太小的选框（误点）忽略——直接退出
    if (sel.w < 4 || sel.h < 4) { exitFrameMode(); return; }
    captureFrame(sel, overlay);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); exitFrameMode(); }
  };

  overlay.addEventListener('mousedown', onDown);
  overlay.addEventListener('mousemove', onMove);
  overlay.addEventListener('mouseup', onUp);
  document.addEventListener('keydown', onKey, true);

  frameCleanup = () => {
    overlay.removeEventListener('mousedown', onDown);
    overlay.removeEventListener('mousemove', onMove);
    overlay.removeEventListener('mouseup', onUp);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    box.remove();
  };
}

function exitFrameMode() {
  frameActive = false;
  frameCleanup?.();
  frameCleanup = null;
}

/**
 * 松手捕获：算命中元素 + 拼快照，做坐标换算，发 frame:captured，然后自动退出。
 *
 * scaledRect（给 host capturePage 用）= webview 可视坐标。如上文坐标模型所述，
 * 视口 CSS 像素坐标即 webview 可视坐标（getBoundingClientRect 已含 transform），
 * 所以 scaledRect 直接 = 选框 sel。这里仍显式构造一份，给 plain 滚动场景留出调整空间。
 */
function captureFrame(sel: FrameRect, overlay: HTMLElement) {
  const hits = pickHitElements(sel, overlay);
  const { htmlSnippet, text, locator } = buildCapturePayload(hits, sel);

  // plain 长页：选区中心若不在视口内，先滚到位再重取坐标（capturePage 只截可视区）。
  // deck 模式 overflow:hidden 不滚动，scrollIntoView 无副作用。
  const cy = sel.y + sel.h / 2;
  const needScroll = currentDeckScale === 1 && (cy < 0 || cy > window.innerHeight);
  let finalSel = sel;
  if (needScroll && hits.length > 0) {
    hits[0].scrollIntoView({ block: 'center' });
    // 重取命中元素 rect 的并集近似 finalSel（滚动后视口坐标变了）
    const merged = hits.reduce<DOMRect | null>((acc, el) => {
      const r = el.getBoundingClientRect();
      if (!acc) return r;
      const left = Math.min(acc.left, r.left);
      const top = Math.min(acc.top, r.top);
      const right = Math.max(acc.right, r.right);
      const bottom = Math.max(acc.bottom, r.bottom);
      return new DOMRect(left, top, right - left, bottom - top);
    }, null);
    if (merged) finalSel = { x: merged.left, y: merged.top, w: merged.width, h: merged.height };
  }

  // scaledRect = webview 可视坐标（= 视口 CSS 像素，不乘 dpr）
  const scaledRect: FrameRect = finalSel;

  ipcRenderer.sendToHost('frame:captured', {
    rect: sel,            // 原始选框（注释 locator 用）
    scaledRect,           // 给 capturePage 的视口坐标
    htmlSnippet,
    text,
    locator,
  });

  exitFrameMode();
}

// host → webview：进入框选模式
ipcRenderer.on('frame:enter', () => {
  enterFrameMode();
});

/**
 * 设计稿尺寸来源：deck HTML `<meta name="oru-deck-size">`，fallback 1920×1080。
 * 选 meta-in-HTML 而非 sidecar 是为了让 deck 保持单文件自描述（脱离 Oru 也能识别比例）。
 *
 * 离散翻页：所有 slide `display: none`，只有 `[data-oru-active]` 一张 `display: flex`；
 * 配合 html/body `overflow: hidden` 彻底废 scroll——末页后没空白可滑、host 持有 currentPage 唯一 state。
 */
function readDeckSize(): { width: number; height: number } {
  const meta = document.querySelector('meta[name="oru-deck-size"]');
  const content = meta?.getAttribute('content') ?? '';
  return parseDeckSizeContent(content) ?? DEFAULT_CANVAS;
}

function injectDeckScale(width: number, height: number) {
  const style = document.createElement('style');
  style.setAttribute('data-oru-deck-scale', '1');
  // 画布骨架与导出态共用 deckFrameCss(单一真相源);预览态额外把缩放原点钉在 top-left——
  // host 推的 scale 与框选坐标模型(getBoundingClientRect 含 transform)都以左上为原点。
  style.textContent = `${deckFrameCss(width, height)}
    html, body { background: #ffffff !important; }
    body { transform-origin: top left; }
  `;
  document.head.appendChild(style);
}

// 当前 deck 缩放比例（host 推过来的 stageBox.width / 设计稿宽）。plain 模式恒为 1。
// 框选坐标换算只用它做注释判定——实际换算见 captureFrame 注释（getBoundingClientRect 已含 transform）。
let currentDeckScale = 1;

// host → webview：host 算好 scale 推过来；preload 只应用 transform
ipcRenderer.on('oru:setDeckScale', (_evt: unknown, scale: number) => {
  if (!Number.isFinite(scale) || scale <= 0) return;
  currentDeckScale = scale;
  document.body.style.transform = `scale(${scale})`;
});

window.addEventListener('DOMContentLoaded', () => {
  injectOruStyles();
  const { width, height } = readDeckSize();

  // 把设计稿尺寸 + slide 总数推给 host：letterbox aspect / scale / 翻页边界都要它
  // 认页按 class `.slide`（不挑标签 section/div/article），与 main 侧 segmentSlides 口径一致——
  // 否则 <div class="slide"> deck 在 UI 里会被判 plain：无翻页 / 无标注 / 无行内编辑 / 无 letterbox。
  const slideCount = document.querySelectorAll('.slide').length;
  const profile: 'deck' | 'plain' = slideCount > 0 ? 'deck' : 'plain';

  if (profile === 'deck') {
    // deck 模式：注入定尺/翻页样式，绑定翻页相关键盘，激活第 0 页
    injectDeckScale(width, height);
    setActivePage(0);
  }
  // plain 模式：不注入 injectDeckScale，让页面保持自然布局 + 原生滚动

  bindContextMenuEdit();
  bindKeyboard();
  bindAsideAltClick();

  ipcRenderer.sendToHost('oru:deckMeta', { width, height, slideCount, profile });
});
