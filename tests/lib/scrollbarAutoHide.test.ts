/** @vitest-environment jsdom */
/**
 * 滚动条自动隐藏：常态不可见、滚动中浮现、停手后收起；指针进滚动条走廊浮现、移开收起。
 * 回归的是「hover 容器就整屏点亮」——指针在内容区中央时不得有任何元素带标记。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installScrollbarAutoHide } from '@/lib/scrollbarAutoHide';

const VISIBLE_ATTR = 'data-scrollbar-visible';
const BOX = { left: 0, top: 0, right: 200, bottom: 100 };

/**
 * jsdom 不排版：滚动几何与 rect 都得手工钉住。
 * 关键是 clientSize 要比 rect 小掉滚动条那条带子的宽度——走廊宽度正是从这个差算出来的。
 */
function makeScroller(
  overflow: { y?: string; x?: string } = { y: 'auto' },
  bar = 10,
): HTMLDivElement {
  const el = document.createElement('div');
  el.style.overflowY = overflow.y ?? 'visible';
  el.style.overflowX = overflow.x ?? 'visible';
  el.style.border = '0';
  const vertical = isScrollable(overflow.y);
  const horizontal = isScrollable(overflow.x);
  Object.defineProperty(el, 'scrollHeight', { value: 500, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 100 - (horizontal ? bar : 0), configurable: true });
  Object.defineProperty(el, 'scrollWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: 200 - (vertical ? bar : 0), configurable: true });
  el.getBoundingClientRect = () => ({ ...BOX, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) });
  document.body.appendChild(el);
  return el;
}

function isScrollable(overflow: string | undefined): boolean {
  return overflow === 'auto' || overflow === 'scroll';
}

function moveTo(target: Element, clientX: number, clientY: number): void {
  target.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, bubbles: true }));
  vi.advanceTimersByTime(20); // 冲掉 rAF 节流
}

let dispose: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom 的 rAF 走真实计时器，fake timers 下不触发；接到宏任务上让节流可推进
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
  dispose = installScrollbarAutoHide();
});

afterEach(() => {
  dispose();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('滚动条自动隐藏', () => {
  it('常态无标记；滚动时浮现，停手 700ms 后收起', () => {
    const el = makeScroller();
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);

    el.dispatchEvent(new Event('scroll'));
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(true);

    vi.advanceTimersByTime(600);
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(true); // 还没到收起线
    vi.advanceTimersByTime(200);
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);
  });

  it('连续滚动不断续期，最后一次停手才收起', () => {
    const el = makeScroller();
    el.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(500);
    el.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(500);
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(true);
    vi.advanceTimersByTime(300);
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);
  });

  it('指针进右缘走廊浮现，回到内容区收起', () => {
    const el = makeScroller();
    moveTo(el, 100, 50); // 内容区中央
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);

    moveTo(el, 195, 50); // 右缘 14px 内
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(true);

    moveTo(el, 100, 50);
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);
  });

  it('走廊命中认方向：只能纵向滚的元素，下缘不算', () => {
    const el = makeScroller({ y: 'auto', x: 'hidden' });
    moveTo(el, 100, 95);
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);

    const wide = makeScroller({ x: 'auto' });
    moveTo(wide, 100, 95);
    expect(wide.hasAttribute(VISIBLE_ATTR)).toBe(true);
  });

  it('overflow 不可滚 / 内容不溢出的元素，走廊里也不亮', () => {
    const clipped = makeScroller({ y: 'hidden' });
    moveTo(clipped, 195, 50);
    expect(clipped.hasAttribute(VISIBLE_ATTR)).toBe(false);

    const fits = makeScroller();
    Object.defineProperty(fits, 'scrollHeight', { value: 100, configurable: true });
    moveTo(fits, 195, 50);
    expect(fits.hasAttribute(VISIBLE_ATTR)).toBe(false);
  });

  it('内层子元素落在祖先滚动容器的走廊上时，点亮的是祖先', () => {
    const scroller = makeScroller();
    const child = document.createElement('div');
    child.getBoundingClientRect = () => ({ ...BOX, right: 200, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) });
    scroller.appendChild(child);

    moveTo(child, 195, 50);
    expect(scroller.hasAttribute(VISIBLE_ATTR)).toBe(true);
    expect(child.hasAttribute(VISIBLE_ATTR)).toBe(false);
  });

  it('悬停在走廊上时，滚动的收起定时器到点也不收起', () => {
    const el = makeScroller();
    moveTo(el, 195, 50);
    el.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1000);
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(true);

    moveTo(el, 100, 50);
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);
  });

  it('走廊按元素实际的滚动条占宽算：6px 细条的走廊也窄一圈', () => {
    const thin = makeScroller({ y: 'auto' }, 6); // 输入框那种细条
    moveTo(thin, 192, 50); // 6px 条 + 4px 瞄准余量之内
    expect(thin.hasAttribute(VISIBLE_ATTR)).toBe(true);

    moveTo(thin, 186, 50); // 若按 10px 条那套硬常数算，这里会误亮
    expect(thin.hasAttribute(VISIBLE_ATTR)).toBe(false);
  });

  it('滚动条被隐藏（占宽 0）的容器，贴着边缘也不点亮', () => {
    const bare = makeScroller({ y: 'auto' }, 0); // 主页那种 scrollbar-width:none
    moveTo(bare, 199, 50);
    expect(bare.hasAttribute(VISIBLE_ATTR)).toBe(false);
  });

  it('指针径直移出窗口：没有后续 mousemove，也要收起', () => {
    const el = makeScroller();
    moveTo(el, 195, 50);
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(true);

    document.dispatchEvent(new MouseEvent('mouseleave'));
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);
  });

  it('卸载后清干净标记与监听', () => {
    const el = makeScroller();
    el.dispatchEvent(new Event('scroll'));
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(true);

    dispose();
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);

    el.dispatchEvent(new Event('scroll'));
    expect(el.hasAttribute(VISIBLE_ATTR)).toBe(false);
    dispose = () => {};
  });
});
