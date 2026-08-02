/**
 * 滚动条自动隐藏：常态不可见；正在滚动、或指针落进滚动条走廊时浮现；停止滚动 / 指针移开后收起。
 *
 * 为什么要 JS 而不是纯 CSS。CSS 能表达的悬停只有两种，都不是需求要的那种：
 * 「悬停在容器上」一次点亮整条命中链上所有滚动容器（指针落在正文里，侧栏和对话区的条一起亮，
 * 正是这次要修的毛病）；「悬停在 thumb 上」（`::-webkit-scrollbar-thumb:hover` 对透明 thumb
 * 照常生效，实测过）只在指针正压住 thumb 时命中——而 thumb 常态不可见、长内容里只有二三十像素高，
 * 等于让人盲摸。指针落在轨道空白处时点亮 thumb 是做不到的：`::-webkit-scrollbar:hover` /
 * `::-webkit-scrollbar-track:hover` 确实存在且覆盖整条走廊，但伪元素之间没有组合子，
 * 这个状态送不到 thumb（实测轨道空白处 hover，thumb 纹丝不动）。
 * 加上「正在滚动」本就是 CSS 表达不了的时序状态——两个显示条件在这里合成为滚动元素上的
 * data-scrollbar-visible，CSS 侧只认这一个属性。
 *
 * 为什么不直接用系统的 overlay 滚动条（它本来就自动隐藏）：只要用 ::-webkit-scrollbar 自定义样式，
 * Chromium 就切回占布局宽度的经典滚动条，overlay 那套拿不到；而配色 token 与 10px 定宽是 index.css
 * 与 ChatArea 像素几何的硬约束，自定义退不掉。
 *
 * 不覆盖文档级滚动（scroll 事件的 target 是 document 而非 Element）：body 是 overflow:hidden，
 * 全站滚动都发生在内部面板里，没有这条路径。
 */

/** 停止滚动后收起的延迟：短于此会在惯性滚动的停顿处闪烁 */
const IDLE_HIDE_MS = 700;
/** 瞄准余量：滚动条常态不可见，指针够不准时往内容区让出这么几像素 */
const AIM_SLACK_PX = 4;
/** 粗筛边界：宽于任何滚动条 + 瞄准余量，用来在读 computed style 之前先把内容区中央的指针挡掉 */
const COARSE_EDGE_PX = 20;

const VISIBLE_ATTR = 'data-scrollbar-visible';

function isScrollableOverflow(value: string): boolean {
  return value === 'auto' || value === 'scroll';
}

/**
 * 指针所在的滚动条走廊：从 target 向上找第一个「压在自己滚动条那条带子上、且该方向真能滚」的祖先。
 *
 * 走廊宽度按各元素实际的滚动条占宽算，不吃硬常数——全站有 10px（默认）、6px（输入框）、
 * 0px（主页，滚动条隐藏）三种，硬常数只对其中一种成立，且会让 0px 那种凭空点亮。
 * 先用 rect 粗筛再读 computed style，省的是每帧的 style 读取；rect 本身可能触发一次强制布局，
 * 那是这套走廊方案的固有成本，换不掉。
 */
function scrollbarZoneAt(event: MouseEvent): Element | null {
  let el = event.target instanceof Element ? event.target : null;
  for (; el; el = el.parentElement) {
    const rect = el.getBoundingClientRect();
    if (event.clientX <= rect.right - COARSE_EDGE_PX && event.clientY <= rect.bottom - COARSE_EDGE_PX) continue;
    const style = getComputedStyle(el);
    // 滚动条占的是 border 与 padding-box 之间那条带子，宽度＝border-box 减去 border 再减去 clientSize
    const innerRight = rect.right - parseFloat(style.borderRightWidth);
    const innerBottom = rect.bottom - parseFloat(style.borderBottomWidth);
    const barWidth = rect.width - el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    const barHeight = rect.height - el.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
    const onVertical = event.clientX > innerRight - barWidth - AIM_SLACK_PX && event.clientX <= innerRight;
    const onHorizontal = event.clientY > innerBottom - barHeight - AIM_SLACK_PX && event.clientY <= innerBottom;
    if (barWidth > 0 && onVertical && el.scrollHeight > el.clientHeight && isScrollableOverflow(style.overflowY)) return el;
    if (barHeight > 0 && onHorizontal && el.scrollWidth > el.clientWidth && isScrollableOverflow(style.overflowX)) return el;
  }
  return null;
}

export function installScrollbarAutoHide(): () => void {
  /** 正在滚动的元素 → 收起定时器；元素卸载后定时器照常清干净（最多多持有引用 IDLE_HIDE_MS） */
  const scrolling = new Map<Element, ReturnType<typeof setTimeout>>();
  let hovered: Element | null = null;
  let queued: MouseEvent | null = null;
  let disposed = false;

  const sync = (el: Element) => {
    if (scrolling.has(el) || el === hovered) el.setAttribute(VISIBLE_ATTR, '');
    else el.removeAttribute(VISIBLE_ATTR);
  };

  // scroll 不冒泡，只能在 capture 阶段收
  const onScroll = (event: Event) => {
    const el = event.target instanceof Element ? event.target : null;
    if (!el) return;
    const pending = scrolling.get(el);
    if (pending) clearTimeout(pending);
    scrolling.set(
      el,
      setTimeout(() => {
        scrolling.delete(el);
        sync(el);
      }, IDLE_HIDE_MS),
    );
    sync(el);
  };

  const settleHover = () => {
    const event = queued;
    queued = null;
    if (disposed || !event) return;
    const next = scrollbarZoneAt(event);
    if (next === hovered) return;
    const previous = hovered;
    hovered = next;
    if (previous) sync(previous);
    if (next) sync(next);
  };

  // 每帧至多算一次命中：mousemove 高频，而走廊判定要读 layout
  const onMouseMove = (event: MouseEvent) => {
    const idle = queued === null;
    queued = event;
    if (idle) requestAnimationFrame(settleHover);
  };

  // 指针径直移出窗口后不会再有 mousemove，没有这一路悬停态就卡在最后一次命中上（滚动条常亮不收）
  const onLeaveWindow = () => {
    queued = null;
    if (!hovered) return;
    const previous = hovered;
    hovered = null;
    sync(previous);
  };

  document.addEventListener('scroll', onScroll, { capture: true });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseleave', onLeaveWindow);

  return () => {
    disposed = true;
    document.removeEventListener('scroll', onScroll, { capture: true });
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseleave', onLeaveWindow);
    for (const [el, timer] of scrolling) {
      clearTimeout(timer);
      el.removeAttribute(VISIBLE_ATTR);
    }
    scrolling.clear();
    hovered?.removeAttribute(VISIBLE_ATTR);
    hovered = null;
    queued = null;
  };
}
