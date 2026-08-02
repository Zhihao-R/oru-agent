import { useCallback, useEffect, useRef, useState } from 'react';

/** 距离底部 ≤ 此像素视为"在底部"，避免用户轻微滑动就被踢出贴底模式 */
const BOTTOM_THRESHOLD_PX = 48;

/** 滚到底，返回落点——方向判据的基准要跟着推到底，否则下一次 onScroll 把这次程序滚动读成上滑 */
function snapToBottom(el: HTMLElement): number {
  el.scrollTop = el.scrollHeight; // 浏览器钳到 scrollHeight - clientHeight
  return el.scrollTop;
}

/**
 * 流式期间贴底/自由浏览状态机。
 *
 * - 初始：stuckToBottom=true。
 * - 用户向上滚（距离底部 > 阈值）→ stuckToBottom=false，UI 显示"回到最新"按钮。
 * - 用户滚回底部 / 调 scrollToBottom → stuckToBottom=true，恢复自动贴底。
 * - 切换 conversationId、或滚动容器换了新实例时强制重置为 true 并滚到底。
 *
 * 契约有两条，各治一类失效：
 *
 * 1. 收元素而非 ref——"容器何时存在"是 hook 自己该观察的事实，不外包给调用方列 deps。
 *    容器可能在组件内被条件渲染换掉（ChatArea 草稿态/手账线早返回另一个页面），此时组件实例、
 *    conversationId、ref 对象身份全都没变，effect 依赖它们等于永不重跑：新容器既不贴底也装不上
 *    滚动监听，scrollTop 停在 0。判据：容器可能被条件挂出/收起 → 收元素；容器与组件同生共死 → ref 即可。
 * 2. 贴底由 ResizeObserver 单点驱动，内容层与视口两侧都观察——不变量是"内容底边对齐视口底边"，
 *    等式两边都会变：内容侧是流式追加、图片/代码块异步撑高；视口侧是输入区上方面板展开、
 *    横幅出现、窗口缩放。只盯一侧，另一侧变化时内容就掉出底部。
 *
 * 用法：
 * ```tsx
 * const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
 * const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
 * const { stuckToBottom, scrollToBottom } = useStickToBottom(scrollEl, contentEl, activeConvId);
 * ```
 */
export function useStickToBottom(
  scrollEl: HTMLElement | null,
  contentEl: HTMLElement | null,
  conversationId: string | null,
): { stuckToBottom: boolean; scrollToBottom: () => void } {
  const [stuckToBottom, setStuckToBottom] = useState(true);

  // 贴底判据的唯一真相源：由 scroll 事件同步写入。
  // 不能用 render 阶段同步的 ref（仓库别处"ref 持最新值喂 effect"的主流写法）——那些场景真相源
  // 是 render 输入故安全；这里真相源是用户 scroll 事件，render 阶段同步会落后于事件，
  // 流式高频 token 触发的贴底 effect 读到陈旧的 true 就把正在上滑的用户拽回底部。
  const stuckRef = useRef(true);
  // 上一次滚动位置，用于判别滚动方向：退出贴底的唯一真实语义是"用户主动上滑"。
  const lastTopRef = useRef(0);

  // 监听用户滚动：stuckRef 是判据真相，stuckToBottom 只是它的边沿投影（驱动"回到最新"按钮显隐）。
  // 程序滚动也派发 scroll，故只在跨阈值翻转时才 setState，避免流式期间每个 token 一次空更新。
  useEffect(() => {
    if (!scrollEl) return;
    const onScroll = () => {
      const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      const atBottom = distance <= BOTTOM_THRESHOLD_PX;
      const scrolledUp = scrollEl.scrollTop < lastTopRef.current;
      lastTopRef.current = scrollEl.scrollTop;
      // 到底永远贴底；离底时只有"上滑"才退出贴底。向下滚——含"回到最新"平滑动画的中途帧、
      // 以及流式追内容——绝不退出，否则动画会把自己打回离底、内容也跟不上。
      const next = atBottom ? true : scrolledUp ? false : stuckRef.current;
      if (next !== stuckRef.current) setStuckToBottom(next);
      stuckRef.current = next;
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [scrollEl]);

  // 换对话、或容器换新实例（从别处回到对话）→ 复位贴底
  useEffect(() => {
    stuckRef.current = true;
    setStuckToBottom(true);
    if (scrollEl) lastTopRef.current = snapToBottom(scrollEl);
  }, [conversationId, scrollEl]);

  // 内容或视口高度变化时跟随到底（仅贴底模式）。ResizeObserver 注册即回调一次，
  // 挂载后异步撑高的每一步也都会回调——所以"回到对话停在半路"不会再出现。
  useEffect(() => {
    if (!scrollEl || !contentEl) return;
    const ro = new ResizeObserver(() => {
      if (stuckRef.current) lastTopRef.current = snapToBottom(scrollEl);
    });
    ro.observe(contentEl); // 内容长高：流式追加、图片/代码块异步撑高
    ro.observe(scrollEl); // 视口变矮：输入区上方面板展开、横幅出现、窗口缩放
    return () => ro.disconnect();
  }, [scrollEl, contentEl]);

  const scrollToBottom = useCallback(() => {
    if (!scrollEl) return;
    // 显式重新贴底意图：动画期间到达的流式内容也跟随；中途的向下帧不会把它翻回离底。
    stuckRef.current = true;
    setStuckToBottom(true);
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
  }, [scrollEl]);

  return { stuckToBottom, scrollToBottom };
}
