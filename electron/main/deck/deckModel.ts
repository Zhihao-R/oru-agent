/**
 * DeckModel —— deck 的"切页 + 取画布"单一来源。
 *
 * 所有按页工作的能力（联系表复查 / 客观校验 / 版本 diff / 重排）都只依赖这里，不再各自抄正则。
 * 三个纯函数、零 node/electron 依赖——故 preload（deckPreview.cjs，独立 webContents）也能 import
 * `parseDeckSizeContent`，main 与渲染端共用同一份画布解析，不并存两套。
 *
 * 切页用正则、不解析 DOM（首期刻意取舍：不引 DOM 解析依赖）：唯一结构约定是"每页一个带 class=\"slide\" 的顶层块"，
 * 标签放宽到 section/div/article（实测覆盖主流 deck skill 写法）。同名标签嵌套（`<div class=slide>`
 * 里又有裸 `<div>`）会被非贪婪 `</\1>` 提前闭合切错——这是诚实边界，走 deckValidator 的"认不出"
 * 告知路径，不静默。日后真要彻底解决就换成离屏 DOM 切页：只动 `segmentSlides` 一处实现，调用方不变。
 */

export type DeckCanvas = { width: number; height: number };

/** 缺省画布 = 16:9 1920×1080（deck 未声明 oru-deck-size 时退回）。 */
export const DEFAULT_CANVAS: DeckCanvas = { width: 1920, height: 1080 };

/**
 * 切页正则：尽量逐项逼近渲染端 CSS 选择器 `.slide` 的语义——deck 自己的 CSS/JS 就是用 `.slide`
 * 定义/切换"页"的，渲染端 `querySelectorAll('.slide')` 是"什么算一页"的语义真相，main 侧必须对齐它，
 * 否则两侧页数/页序分裂 → 标注 pageIndex 错位、profile 判反、view_slide 越界。逐项对齐：
 *  - **任意标签**（`[a-zA-Z][a-zA-Z0-9-]*`，配反向引用 `\1` 闭合同名标签）——CSS `.slide` 不挑标签，
 *    不能只认 section/div/article，否则 `<main class="slide">` 这类 main 漏切、渲染端却认。
 *  - **标签名 / `class` 属性名大小写不敏感**（HTML 语义，靠整体 `i` flag）。
 *  - **class 值 `slide` 大小写敏感**（CSS class 值在标准模式下区分大小写，`.slide` 不认 `SLIDE`）——
 *    用内联修饰符 `(?-i:slide)` 在 `i` flag 内局部关大小写不敏感。
 *  - **整 token**：`slide` 前后必须是引号或 **ASCII 空白**（CSS class 分词只在 `[\t\n\f\r空格]` 上，
 *    不含 NBSP）——不能用 `\bslide\b`（`\b` 把连字符当词边界，会误配 `my-slide`），也不能用 `\s`
 *    （JS `\s` 含 NBSP 等，比 CSS 宽）。
 *  - **开标签属性按"引号感知"消费**（`(?:"[^"]*"|'[^']*'|[^>"'])*`）而非 `[^>]*`——否则属性值里出现
 *    `>`（如 `aria-label="下一步 > 完成"`）会让 `[^>]*` 提前在引号内的 `>` 处截断、整页漏切、页号错位。
 *  - **`class` 属性名前必须是空白**（`\sclass` 而非 `\bclass`）——HTML 属性名以空白分隔，`\b` 会把
 *    `data-class="slide"` 里的 `class` 误当属性名匹配，而 DOM `.slide` 不认 `data-class`。
 *  - **无引号属性值也认**（`class=slide`）——HTML5 合法、渲染端 `.slide` 照样匹配，main 不认会漏切。
 *    无引号值不能含空白/引号，故只可能是单 token `slide`，后面必须紧跟 ASCII 空白或 `>`（值终止符）。
 * 每次切页新建实例——/g 正则有 lastIndex 状态，模块级共享会在并发 exec 循环里互踩。
 * 诚实边界：同名标签嵌套提前闭合（见上文）、void 元素（`<img class="slide">`）无 `</\1>` 不切——
 * 后者现实不发生（slide 是内容容器），不为它放宽。
 */
const SLIDE_RE_SOURCE =
  '<([a-zA-Z][a-zA-Z0-9-]*)\\b(?:"[^"]*"|\'[^\']*\'|[^>"\'])*?\\sclass\\s*=\\s*(?:["\'](?:[^"\']*[\\t\\n\\f\\r ])?(?-i:slide)(?:[\\t\\n\\f\\r ][^"\']*)?["\']|(?-i:slide)(?=[\\t\\n\\f\\r >]))(?:"[^"]*"|\'[^\']*\'|[^>"\'])*>[\\s\\S]*?<\\/\\1>';

export type SlideMatch = { html: string; start: number; end: number };

/**
 * 切页并保留每页在原文里的字节区间（start/end）。reorderSlides 重排要按位置 splice，单独走这个；
 * 不让它另抄一份正则（系统性：切页正则只有这一处）。
 */
export function segmentSlidesWithRanges(html: string): SlideMatch[] {
  const re = new RegExp(SLIDE_RE_SOURCE, 'gi');
  const out: SlideMatch[] = [];
  for (const m of html.matchAll(re)) {
    out.push({ html: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** 切出所有 slide 块的原始 HTML 字符串（每页一个带 class="slide" 的 section/div/article）。 */
export function segmentSlides(html: string): string[] {
  return segmentSlidesWithRanges(html).map((m) => m.html);
}

/**
 * 解析 `<meta name="oru-deck-size">` 的 content 值（形如 `1920x1080` / `1024×768`）。
 * 非法（缺失分隔符 / 非数字 / 非正）→ null，由 getCanvas 退回 DEFAULT_CANVAS。
 * 纯字符串解析，main 侧从 head 字符串正则取 content、渲染端从 DOM 取 content，二者共用这一个。
 */
export function parseDeckSizeContent(content: string): DeckCanvas | null {
  const m = content.match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/);
  if (!m) return null;
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  if (width > 0 && height > 0) return { width, height };
  return null;
}

/** 读整份 deck HTML 的声明画布；缺 meta / 非法 → DEFAULT_CANVAS。 */
export function getCanvas(html: string): DeckCanvas {
  const metaTag = html.match(/<meta\b[^>]*\bname\s*=\s*["']oru-deck-size["'][^>]*>/i);
  if (metaTag) {
    const content = metaTag[0].match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (content) {
      const parsed = parseDeckSizeContent(content[1]);
      if (parsed) return parsed;
    }
  }
  return DEFAULT_CANVAS;
}
