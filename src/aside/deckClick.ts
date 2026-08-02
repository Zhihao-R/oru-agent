/**
 * deck ⌥点的 host 侧翻译——纯函数，PreviewPane 收到 'aside:clicked' 后调用。
 *
 * 职责：AsideDeckClickPayload → AsideReferent（优先级翻译 + label 措辞）+
 * 坐标系换算（webview 视口坐标 → 截图坐标 / 主窗口坐标）。
 * 截图本体的归一在 normalizeShot.ts（DOM 依赖），这里只管坐标与结构。
 */
import type { AsideDeckClickPayload, AsideReferent } from '@shared/types';
import type { AsideClick } from './dispatch';
import { clipLabel as clip } from './label';
// 纯函数（PreviewPane 收 webview 上抛时调用），无 hook，直调 i18n 单例。
// 仅 label 走 t——label 不进 AI prompt，只做指代卡/归档标题（纯 UI 展示）。
// outlineText（含「（无标题）」）与 context 前缀「文稿大纲」是喂模型 class③，不翻。
import i18n from '@/lib/i18n';

// deck 预览的区域 id（二期 §4 场所感）：webview 内点不经 DOM resolver，
// region 在本翻译层直接注入——四档 referent 全带
const DECK_REGION = 'deck-preview' as const;

/**
 * 按优先级翻译成 AsideReferent：
 * 1. 主窗口选区（hostSelectionText，调用方同步查一次）——压过 deck 内选区；
 * 2. deck 内选区（payload.selectionText）；
 * 3. 命中页 → deck-page；
 * 4. 否则 blank（页间留白/容器边缘），大纲如有则作为 context 带上。
 */
export function translateDeckAsideClick(
  payload: AsideDeckClickPayload,
  hostSelectionText: string,
): AsideReferent {
  const hostSel = hostSelectionText.trim();
  if (hostSel) {
    return { type: 'selection', text: hostSel, label: `“${clip(hostSel)}”`, region: DECK_REGION };
  }
  if (payload.selectionText) {
    return {
      type: 'selection',
      text: payload.selectionText,
      // deck 内选区的外层文本 = 所在页全文（命中页时可得）
      surround: payload.pageText || undefined,
      label: `“${clip(payload.selectionText)}”`,
      region: DECK_REGION,
    };
  }
  // 大纲展示/喂模型的统一格式：每页一行 `N. 标题`
  const outlineText = payload.outline
    .map((t, i) => `${i + 1}. ${t || '（无标题）'}`)
    .join('\n');
  if (payload.pageIndex >= 0) {
    const title = payload.outline[payload.pageIndex] ?? '';
    return {
      type: 'deck-page',
      pageIndex: payload.pageIndex,
      text: payload.pageText,
      outline: outlineText,
      label: title
        ? `${i18n.t('aside:pageLabel', { n: payload.pageIndex + 1 })} · ${clip(title)}`
        : i18n.t('aside:pageLabel', { n: payload.pageIndex + 1 }),
      region: DECK_REGION,
    };
  }
  return {
    type: 'blank',
    context: outlineText ? `文稿大纲：\n${outlineText}` : undefined,
    label: i18n.t('aside:narrativePreview'),
    region: DECK_REGION,
  };
}

/**
 * 组装 deck 路径的 AsideClick——两个坐标系各归各：
 * - 截图已归一为逻辑像素（normalizeShot），webview 视口坐标即截图坐标，**不乘 dpr**；
 * - 浮层定位用的 position 是主窗口坐标 = webview 元素偏移 + 点内偏移
 *   （webview 内外 CSS 像素同尺度，直接相加）。
 */
export function assembleDeckAsideClick(args: {
  payload: AsideDeckClickPayload;
  hostSelectionText: string;
  /** 已归一为逻辑像素的截图；失败/超时缺省 */
  screenshotBase64?: string;
  /** webview 元素在主窗口中的位置（getBoundingClientRect） */
  webviewRect: { left: number; top: number };
}): AsideClick {
  const { payload, hostSelectionText, screenshotBase64, webviewRect } = args;
  return {
    referent: translateDeckAsideClick(payload, hostSelectionText),
    screenshot:
      screenshotBase64 !== undefined
        ? { base64: screenshotBase64, x: payload.x, y: payload.y }
        : undefined,
    position: { x: webviewRect.left + payload.x, y: webviewRect.top + payload.y },
  };
}
