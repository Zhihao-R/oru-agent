/** @vitest-environment jsdom */
/**
 * useStickToBottom · 流式期间贴底/自由浏览回归
 *
 * 老 bug 一：贴底判据 stuckRef 只在 render 阶段同步，落后于用户的 scroll 事件。
 * 流式高频 token 触发的贴底 effect 读到陈旧的 true，把正在上滑预览的用户拽回底部，
 * 程序滚动又把状态复位 true，彻底吞掉"离开底部"的意图——表现为上滑无效、一直黏在底部。
 * 修后：scroll 事件同步写 stuckRef，effect 读到的永远是用户最新意图。
 *
 * 老 bug 二（2026-07-27）：hook 收 ref 对象，其身份恒定，故切到手账线/设置页再回到对话、
 * 容器换了新 DOM 节点时所有 effect 都不重跑——新容器不贴底也装不上滚动监听，停在 scrollTop=0，
 * 用户看到最早一条。修后：收元素本身，元素身份变化即重跑。
 *
 * 注：精确的"提交顺序竞态"在 jsdom+act 下无法复现——act() 会先冲掉挂起的 scroll
 * setState（连同旧代码 render 阶段的 ref 同步），把竞态线性化掉，新旧代码看到的可观测
 * 输入完全一致。故下列各例只守护贴底/离底/复位的行为契约，防止退化成"无脑跟随"
 * 或"切换不复位"；竞态本身经真实浏览器流式 playtest 验证。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStickToBottom } from '@/hooks/useStickToBottom';

/** jsdom 无 ResizeObserver：桩记下被观察的元素，由用例手动触发回调模拟内容撑高 */
const roCallbacks = new Map<Element, () => void>();
class ResizeObserverStub {
  constructor(private readonly cb: () => void) {}
  observe(el: Element) {
    roCallbacks.set(el, this.cb);
  }
  disconnect() {
    for (const [el, cb] of roCallbacks) if (cb === this.cb) roCallbacks.delete(el);
  }
  unobserve(el: Element) {
    roCallbacks.delete(el);
  }
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
/** 模拟内容层高度变化（流式追加、图片撑高、挂载后布局稳定） */
function growContent(el: Element) {
  act(() => roCallbacks.get(el)?.());
}

/** 造一个几何可控的滚动容器：scrollHeight/clientHeight 固定，scrollTop 读写打桩 */
function makeScrollEl(scrollHeight: number, clientHeight: number, scrollTop: number) {
  const el = document.createElement('div');
  let _scrollTop = scrollTop;
  const setSpy = vi.fn((v: number) => {
    _scrollTop = v;
  });
  Object.defineProperty(el, 'scrollHeight', { get: () => scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', {
    get: () => _scrollTop,
    set: setSpy,
    configurable: true,
  });
  // jsdom 无 scrollTo，按 top 写回 scrollTop
  el.scrollTo = ((opts: { top?: number }) => {
    if (typeof opts?.top === 'number') setSpy(opts.top);
  }) as typeof el.scrollTo;
  const content = document.createElement('div');
  el.appendChild(content);
  return { el, content, setSpy, moveTo: (t: number) => (_scrollTop = t) };
}

beforeEach(() => roCallbacks.clear());
afterEach(() => vi.clearAllMocks());

describe('useStickToBottom', () => {
  it('在底部时，内容撑高跟随滚到底', () => {
    // 视口 500，内容 1000，scrollTop=500 → 距底 0，处于底部
    const { el, content, setSpy } = makeScrollEl(1000, 500, 500);
    renderHook(() => useStickToBottom(el, content, 'cnv'));
    setSpy.mockClear();

    growContent(content); // 新 token 撑高
    expect(setSpy).toHaveBeenCalledWith(1000); // 跟随到底
  });

  it('用户上滑离开底部后，内容撑高不再把页面拽回底部（回归）', () => {
    const { el, content, setSpy, moveTo } = makeScrollEl(1000, 500, 500);
    renderHook(() => useStickToBottom(el, content, 'cnv'));

    // 用户上滑：scrollTop=100 → 距底 400，远离底部
    moveTo(100);
    el.dispatchEvent(new Event('scroll'));
    setSpy.mockClear();

    growContent(content); // 流式新 token 到达
    expect(setSpy).not.toHaveBeenCalled(); // 不得把用户拽回底部
  });

  it('“回到最新”平滑动画的向下中途帧不退出贴底（老问题回归）', () => {
    // 内容 2000、视口 500。这个竞态是同步方向逻辑，jsdom 下可确定复现：旧实现会被中途帧打回离底。
    const { el, content, moveTo } = makeScrollEl(2000, 500, 2000);
    const { result } = renderHook(() => useStickToBottom(el, content, 'cnv'));

    // 用户上滑离底 → 显示"回到最新"
    moveTo(100);
    act(() => el.dispatchEvent(new Event('scroll')));
    expect(result.current.stuckToBottom).toBe(false);

    // 点"回到最新"，随后平滑动画走到中途（1200，方向向下，尚未到底）
    act(() => result.current.scrollToBottom());
    moveTo(1200);
    act(() => el.dispatchEvent(new Event('scroll')));
    expect(result.current.stuckToBottom).toBe(true); // 不被中途帧打回离底
  });

  it('滚动容器在挂载后才出现（conversationId 由 null 变真值）仍能装上滚动监听器（根因回归）', () => {
    // 草稿态：ChatArea 早返回欢迎页，滚动容器不渲染，元素为 null。
    const { el, content, moveTo } = makeScrollEl(2000, 500, 2000);
    const { result, rerender } = renderHook(
      (p: { el: HTMLElement | null; conv: string | null }) =>
        useStickToBottom(p.el, content, p.conv),
      { initialProps: { el: null as HTMLElement | null, conv: null as string | null } },
    );

    // 进对话：容器挂出，conversationId 变真值
    act(() => rerender({ el, conv: 'c1' }));

    // 用户上滑——监听器必须已补上并响应
    moveTo(100);
    act(() => el.dispatchEvent(new Event('scroll')));
    expect(result.current.stuckToBottom).toBe(false);
  });

  it('同一对话里容器换新实例（从手账/设置页回到对话）复位贴底并跟随后续撑高（回归）', () => {
    // 旧实现收 ref 对象：身份恒定 + conversationId 没变 → 所有 effect 都不重跑，
    // 新容器停在 scrollTop=0，用户回来看到的是最早一条。
    const first = makeScrollEl(2000, 500, 2000);
    const { rerender } = renderHook(
      (p: { el: HTMLElement; content: HTMLElement }) =>
        useStickToBottom(p.el, p.content, 'cnv'),
      { initialProps: { el: first.el, content: first.content } },
    );

    // 离开对话再回来：容器是全新 DOM 节点，scrollTop 从 0 起
    const next = makeScrollEl(2000, 500, 0);
    act(() => rerender({ el: next.el, content: next.content }));
    expect(next.setSpy).toHaveBeenCalledWith(2000); // 立即贴底，不停在最早一条

    // 新容器的滚动监听器也必须已装上：用户上滑要能退出贴底
    next.setSpy.mockClear();
    next.moveTo(100);
    act(() => next.el.dispatchEvent(new Event('scroll')));
    growContent(next.content);
    expect(next.setSpy).not.toHaveBeenCalled();
  });

  it('回到对话后内容异步撑高（图片/代码块）继续贴底，不停在半路（回归）', () => {
    // 首帧高度不足时一次性 scrollTop=scrollHeight 只滚到"当时的底"，之后撑高就错位。
    let height = 600;
    const el = document.createElement('div');
    let top = 0;
    Object.defineProperty(el, 'scrollHeight', { get: () => height, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => 500, configurable: true });
    Object.defineProperty(el, 'scrollTop', {
      get: () => top,
      set: (v: number) => (top = v),
      configurable: true,
    });
    const content = document.createElement('div');
    el.appendChild(content);

    renderHook(() => useStickToBottom(el, content, 'cnv'));
    expect(top).toBe(600);

    height = 4000; // 图片加载完、代码块高亮完
    growContent(content);
    expect(top).toBe(4000);
  });

  it('视口变矮（输入区面板展开）也跟随到底，不只盯内容层（回归）', () => {
    // 贴底的不变量是"内容底边对齐视口底边"，等式两边都会变：待决策面板/计划清单展开会把
    // 滚动容器挤矮，内容层高度纹丝不动。只观察内容层的话最后几条就此掉出视口下缘。
    const { el, content, setSpy } = makeScrollEl(2000, 500, 1500);
    renderHook(() => useStickToBottom(el, content, 'cnv'));
    setSpy.mockClear();

    growContent(el); // 观察的是滚动容器本身：视口高度变了
    expect(setSpy).toHaveBeenCalledWith(2000);
  });

  it('切换 conversation 复位为贴底并滚到底', () => {
    const { el, content, setSpy } = makeScrollEl(1000, 500, 100);
    const { rerender } = renderHook(
      (p: { conv: string }) => useStickToBottom(el, content, p.conv),
      { initialProps: { conv: 'a' } },
    );
    setSpy.mockClear();

    act(() => rerender({ conv: 'b' }));
    expect(setSpy).toHaveBeenCalledWith(1000);
  });
});
