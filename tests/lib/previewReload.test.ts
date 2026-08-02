/**
 * 预览刷新节流控制器（块③·演示稿/网页「看见」，tech §2.3）。
 *
 * 命中 fs.changed 后约 0.5s 内的连续广播合并为一次 reload（AI 连续多刀只刷一次），
 * 并驱动角标「正在同步…→已更新→消失」。reload 与位置保持由调用方注入（deck 走 currentPage、
 * html 走 scrollTop），本控制器只管节流与角标状态机——纯逻辑、可单测。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreviewReloader, type PreviewBadge } from '../../src/lib/previewReload';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('createPreviewReloader', () => {
  it('单次命中：0.5s 后 reload 一次，角标 syncing→updated→null', async () => {
    const reloads: number[] = [];
    const badges: PreviewBadge[] = [];
    const r = createPreviewReloader({ reload: () => reloads.push(1), onBadge: (b) => badges.push(b) });
    r.hit();
    expect(badges).toEqual(['syncing']); // 命中即显示正在同步
    expect(reloads).toHaveLength(0); // 还没刷
    await vi.advanceTimersByTimeAsync(500);
    expect(reloads).toHaveLength(1); // 0.5s 后刷一次
    expect(badges).toEqual(['syncing', 'updated']);
    await vi.advanceTimersByTimeAsync(1200);
    expect(badges).toEqual(['syncing', 'updated', null]); // 已更新短暂后消失
  });

  it('0.5s 内连续多次命中 → 合并为一次 reload（不每改一处刷一次）', async () => {
    const reloads: number[] = [];
    const r = createPreviewReloader({ reload: () => reloads.push(1), onBadge: () => {} });
    r.hit();
    await vi.advanceTimersByTimeAsync(300);
    r.hit(); // 第二刀在窗口内 → 重置节流
    await vi.advanceTimersByTimeAsync(300);
    r.hit();
    await vi.advanceTimersByTimeAsync(499);
    expect(reloads).toHaveLength(0); // 还在合并窗口里，没刷
    await vi.advanceTimersByTimeAsync(1);
    expect(reloads).toHaveLength(1); // 停手 0.5s 后只刷一次
  });

  it('两轮（间隔 > 0.5s）→ 各刷一次', async () => {
    const reloads: number[] = [];
    const r = createPreviewReloader({ reload: () => reloads.push(1), onBadge: () => {} });
    r.hit();
    await vi.advanceTimersByTimeAsync(500);
    expect(reloads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    r.hit();
    await vi.advanceTimersByTimeAsync(500);
    expect(reloads).toHaveLength(2);
  });

  it('dispose 后命中不再 reload（卸载清理）', async () => {
    const reloads: number[] = [];
    const r = createPreviewReloader({ reload: () => reloads.push(1), onBadge: () => {} });
    r.hit();
    r.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reloads).toHaveLength(0);
  });

  it('dispose 归零角标（effect 重建/对比态切换时不孤悬，回归）', () => {
    const badges: PreviewBadge[] = [];
    const r = createPreviewReloader({ reload: () => {}, onBadge: (b) => badges.push(b) });
    r.hit();
    expect(badges).toEqual(['syncing']); // 命中显示同步中
    r.dispose();
    expect(badges).toEqual(['syncing', null]); // dispose 把角标归零，不残留
  });
});
