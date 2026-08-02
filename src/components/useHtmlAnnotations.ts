import { useEffect, useRef } from 'react';
import type { Annotation } from '@shared/types';
import { useHtmlAnnotStore } from '@/stores/htmlAnnotStore';

/**
 * HTML 预览「框选标注」回路（项目B 第三期 Task15）——镜像 deck PreviewPane 的 frame:captured 链路。
 *
 * 桶生命周期（activate/deactivate）由 workspace 标签开/关驱动（FileTree.openTab 后 activate、
 * 标签 closer deactivate），与 editor/table 一致；本 hook 只读本桶信号驱动 webview、回收标注。
 * 身份口径：store 按 ref（项目相对 path）分桶，故各动作/信号都按 ref 取。
 *
 * - 框选：消费本桶 frameSelectSignal → webview.send('frame:enter')（preload deckPreview 盖 overlay 画框）。
 * - 松手：webview ipc-message 'frame:captured' → capturePage(scaledRect) 截图 → html.addAnnotation 落 sidecar。
 *   html 不存定位（PRD「点卡片不跳」），只带 comment/htmlSnippet/text + crop 图。
 * - reload：消费本桶 reloadSignal（html.indexChanged 落地，对比态已在 store 守卫跳过）→ webview.reload()。
 */
export type HtmlAnnotWebview = HTMLElement & {
  reload(): void;
  send(channel: string, ...args: unknown[]): void;
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<{
    toPNG(): Uint8Array;
    isEmpty(): boolean;
  }>;
};

// NativeImage.toPNG() bytes → base64（无 data: 前缀）。分块避免 fromCharCode(...大数组) 爆栈。
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function useHtmlAnnotations(ref: string, wv: HtmlAnnotWebview | null): void {
  // 框选信号 → 进框选模式（对比态忽略：store 的 requestFrameSelect 无条件自增，这里按 compareState 拦）
  const frameSelectSignal = useHtmlAnnotStore((s) => s.byRef[ref]?.frameSelectSignal ?? 0);
  const comparing = useHtmlAnnotStore((s) => s.byRef[ref]?.compareState != null);
  const lastFrameSignalRef = useRef(0);
  useEffect(() => {
    if (frameSelectSignal === lastFrameSignalRef.current) return;
    lastFrameSignalRef.current = frameSelectSignal;
    if (frameSelectSignal === 0 || comparing) return;
    try {
      wv?.send('frame:enter');
    } catch {
      /* webview 未 ready */
    }
  }, [frameSelectSignal, comparing, wv]);

  // reload 信号（html.indexChanged）→ 整页 reload
  const reloadSignal = useHtmlAnnotStore((s) => s.byRef[ref]?.reloadSignal ?? 0);
  const lastReloadRef = useRef(0);
  useEffect(() => {
    if (reloadSignal === lastReloadRef.current) return;
    lastReloadRef.current = reloadSignal;
    if (reloadSignal === 0) return;
    try {
      wv?.reload();
    } catch {
      /* webview 未 ready */
    }
  }, [reloadSignal, wv]);

  // frame:captured 监听跟着 webview 元素走（参照 PreviewPane）：元素换/卸载时摘旧挂新
  useEffect(() => {
    if (!wv) return;
    const onMsg = async (ev: Event) => {
      const e = ev as unknown as { channel: string; args: unknown[] };
      if (e.channel !== 'frame:captured') return;
      const { scaledRect, htmlSnippet, text } = e.args[0] as {
        scaledRect: { x: number; y: number; w: number; h: number };
        htmlSnippet: string;
        text: string;
        locator: Annotation['locator'];
      };
      let cropPngBase64: string | undefined;
      try {
        // capturePage 吃 DIP 坐标；preload 已给视口 CSS 像素，不乘 dpr。取整避免亚像素返回空图。
        const img = await wv.capturePage({
          x: Math.round(scaledRect.x),
          y: Math.round(scaledRect.y),
          width: Math.max(1, Math.round(scaledRect.w)),
          height: Math.max(1, Math.round(scaledRect.h)),
        });
        if (!img.isEmpty()) cropPngBase64 = uint8ToBase64(img.toPNG());
      } catch {
        /* 截图失败 → 降级无图标注，AI 靠 htmlSnippet */
      }
      // html 不存定位（不传 locator → 后端归零）；crop 图 + 片段交给 AI
      await useHtmlAnnotStore.getState().addAnnotation(
        ref,
        { comment: '', htmlSnippet, text },
        cropPngBase64,
      );
    };
    wv.addEventListener('ipc-message', onMsg);
    return () => wv.removeEventListener('ipc-message', onMsg);
  }, [wv, ref]);
}
