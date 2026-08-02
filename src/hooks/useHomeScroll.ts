/**
 * 主页滚动叙事。
 *
 * - 滚动条全程视觉隐藏（容器 class 处理）；首屏往下滚 → 平滑吸附到手账顶（走 snapToJournal 同一条
 *   `scrollTo({behavior:'smooth'})` 动画）。关键是吸附期间用非被动 wheel 监听 preventDefault 吃掉
 *   原生滚动——之前「突然跳」的根因就是原生滚动与平滑动画同时进行、互相打架；吃掉原生滚动后，
 *   滚轮触发的吸附与点击手账预览区触发的吸附是同一条丝滑动画。吸附锁 800ms 内不重复触发；
 * - 首屏底部浮现的手账用「视口锚定的底缘渐隐」呈现（journalFadePx → 容器 mask-image 渐变），
 *   而非给整段手账压一个统一 opacity；随下滚 sc 增大渐隐带回缩到 0，滚进手账后正文不再被削；
 * - 启动器高度 = 视口高 − PEEK，让输入栏落在视口垂直中线附近，底部恰好留 PEEK 高的手账预览；
 * - scrollTop > 520 浮现左侧目录。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** 首屏底部留给手账预览 / 渐隐带的高度（启动器据此从视口高收缩，输入栏因而居中） */
const PEEK = 132;
/** 渐隐带回缩距离：下滚 0→160px 内渐隐带 PEEK→0，之后手账正文完整无削 */
const FADE_RECEDE = 160;
const SNAP_OFFSET = 28;
const SNAP_LOCK_MS = 800;
const TOC_THRESHOLD = 520;

export function useHomeScroll() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const journalRef = useRef<HTMLDivElement | null>(null);
  const snapUntilRef = useRef(0);
  const [sc, setSc] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  const journalTop = useCallback(() => {
    const j = journalRef.current;
    return j ? Math.max(0, j.offsetTop - SNAP_OFFSET) : 0;
  }, []);

  // behavior 默认 smooth（首屏往下滚的连续手势）；顶栏点手账进手账页传 'auto' 瞬时定位——
  // 切页跳转本就该瞬时，且程序化 smooth 在刚挂载/非 trusted 触发时不稳（会落不到位）。
  const snapToJournal = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    snapUntilRef.current = Date.now() + SNAP_LOCK_MS;
    el.scrollTo({ top: journalTop(), behavior });
  }, [journalTop]);

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const st = el.scrollTop;
    // 不做像素级节流——setSc 只驱动一处 mask 内联样式与两个阈值（居中/520），React batching 足够。
    setSc((prev) => (prev === st ? prev : st));
  }, []);

  // 首屏下滚吸附 + 视口测量：wheel 必须是非被动监听才能 preventDefault（React 合成 onWheel 拦不住），
  // 故走原生 addEventListener；视口高随窗口变、用 ResizeObserver 跟随，初测放在 layout 阶段避免首帧闪。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // 吸附动画进行中：吃掉滚轮，别让原生滚动与平滑动画打架（那是「突然跳」的根因）。
      if (Date.now() < snapUntilRef.current) {
        e.preventDefault();
        return;
      }
      // 首屏内往下滚一次即吸附到手账顶——与点击预览区同一条平滑动画。
      const jTop = journalTop();
      if (e.deltaY > 0 && el.scrollTop < jTop - 60) {
        e.preventDefault();
        snapUntilRef.current = Date.now() + SNAP_LOCK_MS;
        el.scrollTo({ top: jTop, behavior: 'smooth' });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    setSc(el.scrollTop);
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);

    return () => {
      el.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  }, [journalTop]);

  // 渐隐带高度：首屏满 PEEK，下滚 FADE_RECEDE 内线性回缩到 0。
  const journalFadePx = Math.round(PEEK * (1 - Math.min(1, sc / FADE_RECEDE)));

  return {
    scrollRef,
    journalRef,
    sc,
    /** 启动器 min-height：视口高 − PEEK；layout 阶段即测得，首帧无闪（未测得前回落 undefined） */
    launcherMinH: viewportH ? viewportH - PEEK : undefined,
    /** 视口底缘渐隐带像素高（0 = 无渐隐），驱动滚动容器 mask-image */
    journalFadePx,
    tocVisible: sc > TOC_THRESHOLD,
    onScroll,
    snapToJournal,
    scrollToTop,
  };
}
