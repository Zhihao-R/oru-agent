/**
 * render_html 的纯解析/文案逻辑——零运行时依赖（只 type-only 引用 RenderRequest），
 * 便于单测，不拉进 Electron / app 模块图。tool（renderHtml.ts）从这里取。
 */
import type { RenderRequest } from '../../render/htmlRenderer';

export type RenderHtmlInput = {
  path?: string;
  html?: string;
  base_dir?: string;
  scroll_y?: number;
  viewport_width?: number;
  viewport_height?: number;
};

/** 把工具入参解析/校验成 RenderRequest（不含 signal）。返回 error 文案或 req。 */
export function parseRenderInput(
  input: unknown,
): { error: string } | { req: Omit<RenderRequest, 'signal'> } {
  const v = (input ?? {}) as RenderHtmlInput;
  const hasPath = typeof v.path === 'string' && v.path.trim().length > 0;
  const hasHtml = typeof v.html === 'string' && v.html.length > 0;

  if (!hasPath && !hasHtml) {
    return { error: 'render_html: 必须提供 path（HTML 文件路径）或 html（内联 HTML）之一' };
  }
  if (hasPath && hasHtml) return { error: 'render_html: path 与 html 只能给一个，不能同时给' };
  if (hasHtml && !(typeof v.base_dir === 'string' && v.base_dir.trim().length > 0)) {
    return {
      error: 'render_html: 用 html（内联）时必须提供 base_dir（相对资源根目录，通常是 deck/制品目录）',
    };
  }

  if (v.scroll_y !== undefined && (!Number.isFinite(v.scroll_y) || v.scroll_y < 0)) {
    return { error: `render_html: scroll_y 必须是 ≥0 的数，得到 ${v.scroll_y}` };
  }
  const vw = v.viewport_width;
  const vh = v.viewport_height;
  if (vw !== undefined && (!Number.isFinite(vw) || vw <= 0)) {
    return { error: `render_html: viewport_width 必须是正数，得到 ${vw}` };
  }
  if (vh !== undefined && (!Number.isFinite(vh) || vh <= 0)) {
    return { error: `render_html: viewport_height 必须是正数，得到 ${vh}` };
  }
  // 二者要给就一起给——只给一个会得到一个非预期的混搭视口
  if ((vw === undefined) !== (vh === undefined)) {
    return {
      error: 'render_html: viewport_width 和 viewport_height 要么都给、要么都不给（默认 1920×1080）',
    };
  }

  // viewport 默认值归原语兜底（DEFAULT_VIEWPORT 只在 htmlRenderer 一处）——两边都给才设，否则留 undefined
  const viewport = vw !== undefined && vh !== undefined ? { width: vw, height: vh } : undefined;
  const source: RenderRequest['source'] = hasPath
    ? { kind: 'file', path: v.path!.trim() }
    : { kind: 'inline', html: v.html!, baseDir: v.base_dir!.trim() };

  return { req: { source, scrollY: v.scroll_y, viewport } };
}

/** 渲染成功时给模型看的文案——含视口、长页提示、空白提示。 */
export function formatRenderText(meta: {
  width: number;
  height: number;
  contentHeight: number;
  hasMore: boolean;
  isBlank: boolean;
  scrollY: number;
}): string {
  const { width, height, contentHeight, hasMore, isBlank, scrollY } = meta;
  const where = scrollY > 0 ? `从 ${scrollY}px 处` : '首屏';
  let text = `已渲染${where}（视口 ${width}×${height}，文档总高 ${contentHeight}px）。`;
  if (hasMore) {
    text += `\n页面比一屏长，下面还有内容——想继续看传 scroll_y=${scrollY + height}。`;
  }
  if (isBlank) {
    text += `\n⚠️ 截图接近全白，这一屏可能没渲染出可见内容（检查 HTML 是否有内容、图片路径是否有效、是否被脚本清空）。`;
  }
  return text;
}
