/**
 * 预览刷新节流控制器（块③·演示稿/网页「看见」，tech §2.3）。
 *
 * 演示稿 / 网页预览是独立渲染的画面，只能整体重绘——收到命中 fs.changed 后约 0.5s 内的连续广播
 * 合并为一次 reload（AI 改一份大文稿常涉多处，不每改一处刷一次），并驱动角落角标
 * 「正在同步…→已更新→消失」让你确认画面实时。reload 与位置保持（deck 页码 / html 滚动）由调用方
 * 在 reload 回调里实现，本控制器只管节流与角标状态机，纯逻辑、可单测。
 */
export type PreviewBadge = 'syncing' | 'updated' | null;

export type PreviewReloader = {
  /** 收到一次命中本预览文件的 fs.changed 广播。 */
  hit: () => void;
  /** 卸载清理（清未触发的 timer），dispose 后 hit 不再 reload。 */
  dispose: () => void;
};

export function createPreviewReloader(opts: {
  reload: () => void;
  onBadge: (badge: PreviewBadge) => void;
  /** 命中后合并窗口（默认 500ms）。 */
  throttleMs?: number;
  /** 「已更新」停留时长后消失（默认 1200ms）。 */
  updatedMs?: number;
}): PreviewReloader {
  const throttleMs = opts.throttleMs ?? 500;
  const updatedMs = opts.updatedMs ?? 1200;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let updatedTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearCoalesce = (): void => {
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
  };

  return {
    hit() {
      if (disposed) return;
      if (!coalesceTimer) opts.onBadge('syncing'); // 第一刀即显示正在同步，合并期间保持
      clearCoalesce();
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        opts.reload();
        opts.onBadge('updated');
        if (updatedTimer) clearTimeout(updatedTimer);
        updatedTimer = setTimeout(() => {
          updatedTimer = null;
          opts.onBadge(null);
        }, updatedMs);
      }, throttleMs);
    },
    dispose() {
      disposed = true;
      clearCoalesce();
      if (updatedTimer) {
        clearTimeout(updatedTimer);
        updatedTimer = null;
      }
      opts.onBadge(null); // 归零角标——effect 重建（进/退对比态）时不让上一轮 syncing/updated 孤悬
    },
  };
}
