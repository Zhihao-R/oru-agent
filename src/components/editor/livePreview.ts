import type { EditorState, Extension, Range, Text } from '@codemirror/state';
import { Facet, MapMode, StateEffect, StateField } from '@codemirror/state';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { renderInline } from './inlineMarkdown';
// 非 React 的 CM widget：拿不到 useTranslation hook，直调 i18n 单例（toDOM 渲染时取当前语言）。
// 代价：切语言不 live 重渲染，随 widget 下次重建（编辑/装饰变化）才更新——低频动作，可接受。
import i18n from '@/lib/i18n';
import { docImageUrl, type DocIdentity } from '@/lib/docImageUrl';
import type { Align, TableModel } from './tableModel';
import {
  cellChangeAt,
  parseTable,
  serialize,
  tableAt,
  withColDeleted,
  withColInserted,
  withRowDeleted,
  withRowInserted,
} from './tableModel';

/**
 * Typora 式实时预览：文档永远是 markdown 源码，本装饰层负责
 * "非光标行隐藏标记、应用排版"。光标/选区触到的行豁免隐藏（标记露出），
 * 行级装饰（引用竖线、代码块底色）不豁免。
 * 规格：docs/prd/2026-06-12-md-live-preview-prd.md
 */

class BulletWidget extends WidgetType {
  readonly kind = 'bullet';
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-livemd-bullet';
    span.textContent = '•';
    return span;
  }
  override eq(): boolean {
    return true;
  }
}

/**
 * 把 anchor 位置所在的任务标记 `[ ]`↔`[x]` 整段对调（走正常 dispatch + 既有实时保存）。
 * 与 replaceImageSourceAt 同构：点击时（box 仍挂载）同步快照 pos，此处按 pos 重定位 TaskMarker 节点。
 * pos 失效（并发编辑后该处已非任务标记）则 no-op，不抛、不误改别处。
 */
function toggleTaskAt(view: EditorView, pos: number): void {
  let from = -1;
  let to = -1;
  syntaxTree(view.state).iterate({
    from: pos,
    to: pos + 1,
    enter: (ref) => {
      if (from < 0 && ref.name === 'TaskMarker') {
        from = ref.from;
        to = ref.to;
        return false;
      }
    },
  });
  if (from < 0) return; // 并发编辑后该处已非任务标记则 no-op，不误改别处
  const checked = /x/i.test(view.state.doc.sliceString(from, to));
  view.dispatch({ changes: { from, to, insert: checked ? '[ ]' : '[x]' } });
}

class TaskWidget extends WidgetType {
  readonly kind = 'task';
  constructor(readonly checked: boolean) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-livemd-task';
    // 勾选态只由文档源码驱动，原生 checkbox 永不自行翻转：
    // mousedown 阻光标落进该行（否则露源码卸载本 widget）；click 拦下原生翻转、改写 [ ]↔[x]。
    // 鼠标点击与键盘 Space 都派发 click，故两条激活路径统一，不会"勾上又被装饰重建弹回"。
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      toggleTaskAt(view, view.posAtDOM(box));
    });
    return box;
  }
  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked;
  }
}

class HrWidget extends WidgetType {
  readonly kind = 'hr';
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-livemd-hr';
    return span;
  }
  override eq(): boolean {
    return true;
  }
}

/**
 * 文档身份与 docImageUrl 的唯一来源在 src/lib/docImageUrl.ts（导出端 renderToStaticMarkup 也复用，
 * 不想被拖进 CM 依赖）。这里 re-export 让既有 CM 侧 import 不变；Facet 绑本 view 实例（§4.1 去全局态）。
 */
export { docImageUrl };
export type { DocIdentity };
export const docIdentityFacet = Facet.define<DocIdentity | null, DocIdentity | null>({
  combine: (values) => values[0] ?? null,
});

/** 图引用的语法节点名（替换/定位用，同 Table 行做法 return false 跳子树）。 */
const IMG_NODE_NAMES = new Set(['Image', 'HTMLBlock', 'HTMLTag']);

/**
 * 裁剪请求通道：widget 发起裁剪、EditorPane 接住开对话框（CM widget ↔ React 桥）。
 * 绑在 CM view 实例上的 Facet——多 md 编辑器并存（右栏多标签 keep-mounted）时，各 view 各自的
 * handler 互不覆盖（曾是模块级单例，后注册会盖掉先者）。每个 view 只有一个 provider，combine 取它。
 */
export type CropRequest = { url: string; apply: (croppedRef: string) => void };
export type CropHandler = (req: CropRequest) => void;
export const cropRequestFacet = Facet.define<CropHandler | null, CropHandler | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * 把 anchor 位置所在的图源码节点整段替换成新源码（走编辑器正常 dispatch + 既有实时保存）。
 * 收 pos 而非 wrap DOM：裁剪是异步的（落盘回来才改引用），届时 wrap 可能已被装饰重建卸载，
 * posAtDOM(detached) 会抛/错位；故位置在点击时（wrap 仍挂载）同步快照、此处只按 pos 重定位。
 * pos 失效（并发编辑后该处已非图节点）则 no-op，不抛、不误改别处文本。
 */
function replaceImageSourceAt(view: EditorView, pos: number, newSource: string): void {
  if (pos < 0 || pos > view.state.doc.length) return;
  let from = -1;
  let to = -1;
  syntaxTree(view.state).iterate({
    from: pos,
    to: pos + 1,
    enter: (ref) => {
      if (from < 0 && IMG_NODE_NAMES.has(ref.name)) {
        from = ref.from;
        to = ref.to;
        return false;
      }
    },
  });
  if (from < 0) return;
  view.dispatch({ changes: { from, to, insert: newSource } });
}

/**
 * 图片内联缩略图 widget（本期唯一基本全新的 widget；复用的只是 livePreview 框架）。
 * 异步加载是 <img> 原生行为，不手写 async；onerror → 朴素「图片缺失」占位（断链/未落地，不裸链接不空白不崩）。
 * hover 浮现工具条（对齐/尺寸/裁剪），动作把 {src,width,align} 经 buildImageSource 写回源码那一段。
 * eq 按 url+width+align：同位置换图/改尺寸/改对齐才重建（alt 不进渲染/eq，仅改写时随源码保留）。
 */
export class ImageWidget extends WidgetType {
  readonly kind = 'image';
  constructor(
    readonly url: string,
    readonly width: number | null,
    readonly align: 'left' | 'center' | 'right',
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-livemd-img';
    wrap.style.textAlign = this.align;

    const img = document.createElement('img');
    img.src = this.url;
    if (this.width != null) img.style.width = `${this.width}px`;
    img.onerror = () => {
      const ph = document.createElement('span');
      ph.className = 'cm-livemd-img-missing';
      ph.textContent = i18n.t('editor:img.missing');
      img.replaceWith(ph);
    };
    wrap.appendChild(img);

    // hover 工具条：mousedown 阻断默认，避免点按钮把光标落进该行露出源码。
    // 所有动作在点击时（wrap 仍挂载）同步取 pos 再改写——同步动作即时用，裁剪异步动作把 pos 带进回调。
    const rewrite = (w: number | null, a: 'left' | 'center' | 'right'): void =>
      replaceImageSourceAt(view, view.posAtDOM(wrap), buildImageSource(this.src, w, a, this.alt));
    const mkBtn = (label: string, title: string, onAct: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onAct();
      });
      return b;
    };
    const sep = (): HTMLSpanElement => {
      const s = document.createElement('span');
      s.className = 'cm-livemd-img-sep';
      return s;
    };
    const bar = document.createElement('span');
    bar.className = 'cm-livemd-img-bar';
    bar.append(
      mkBtn(i18n.t('editor:img.alignLeft'), i18n.t('editor:img.alignLeftTitle'), () => rewrite(this.width, 'left')),
      mkBtn(i18n.t('editor:img.alignCenter'), i18n.t('editor:img.alignCenterTitle'), () => rewrite(this.width, 'center')),
      mkBtn(i18n.t('editor:img.alignRight'), i18n.t('editor:img.alignRightTitle'), () => rewrite(this.width, 'right')),
      sep(),
      mkBtn('S', i18n.t('editor:img.sizeSmallTitle'), () => rewrite(240, this.align)),
      mkBtn('M', i18n.t('editor:img.sizeMediumTitle'), () => rewrite(400, this.align)),
      mkBtn('L', i18n.t('editor:img.sizeLargeTitle'), () => rewrite(600, this.align)),
      mkBtn(i18n.t('editor:img.sizeOrig'), i18n.t('editor:img.sizeOrigTitle'), () => rewrite(null, this.align)),
      sep(),
      mkBtn(i18n.t('editor:img.crop'), i18n.t('editor:img.cropTitle'), () => {
        const pos = view.posAtDOM(wrap); // 点击时快照位置；裁剪落盘回来后 wrap 可能已卸载
        view.state.facet(cropRequestFacet)?.({
          url: this.url,
          // 裁剪刻意落纯 markdown ![]()（width=null、align=left）——成功标准 7 要求裁剪引用不含 HTML、
          // 哪都认可移植，故不保留原宽度/对齐（用户裁完可一键重设）。alt 仍随源码保留。
          apply: (ref) => replaceImageSourceAt(view, pos, buildImageSource(ref, null, 'left', this.alt)),
        });
      }),
    );
    wrap.appendChild(bar);
    return wrap;
  }
  override eq(o: ImageWidget): boolean {
    return o.url === this.url && o.width === this.width && o.align === this.align;
  }
}

const hide = Decoration.replace({});
const bulletDeco = Decoration.replace({ widget: new BulletWidget() });
const hrDeco = Decoration.replace({ widget: new HrWidget() });
const quoteLine = Decoration.line({ class: 'cm-livemd-quote' });
const codeLine = Decoration.line({ class: 'cm-livemd-code' });
const fenceDim = Decoration.mark({ class: 'cm-livemd-fence' });

/** 标记后随一个空格时连空格一起隐藏（`# 标题`、`> 引用`），与渲染态左缘对齐 */
function hideWithSpace(state: EditorState, from: number, to: number): Range<Decoration> {
  const next = state.doc.sliceString(to, to + 1);
  return hide.range(from, next === ' ' ? to + 1 : to);
}

export function buildDecorations(state: EditorState, from: number, to: number): DecorationSet {
  return buildDecorationsForRanges(state, [{ from, to }]);
}

/**
 * 多段可视区域共用一套收集结构：跨段的容器节点（引用/代码块横跨折叠缺口时）
 * 在每段都会被 iterate 进入，行装饰靠 Map 天然去重，围栏淡化靠 seenFences 去重，
 * 避免 join 后同位置装饰重复。
 */
function buildDecorationsForRanges(
  state: EditorState,
  spans: readonly { from: number; to: number }[],
): DecorationSet {
  const doc = state.doc;
  const docIdentity = state.facet(docIdentityFacet); // 本 view 的文档身份，编进图片 URL（§4.1）

  // 露源码行集合：选区（含光标）触到的所有行
  const reveal = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = doc.lineAt(r.from).number;
    const b = doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) reveal.add(n);
  }
  const onRevealLine = (pos: number): boolean => reveal.has(doc.lineAt(pos).number);

  const ranges: Range<Decoration>[] = [];
  // 行级装饰按行首去重（嵌套引用、引用内代码块只下一次同类装饰）
  const lineClasses = new Map<number, Set<Decoration>>();
  const addLineDeco = (nodeFrom: number, nodeTo: number, deco: Decoration): void => {
    const first = doc.lineAt(nodeFrom).number;
    const last = doc.lineAt(nodeTo).number;
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      let set = lineClasses.get(line.from);
      if (!set) {
        set = new Set();
        lineClasses.set(line.from, set);
      }
      set.add(deco);
    }
  };

  const seenFences = new Set<number>();

  for (const span of spans) {
    syntaxTree(state).iterate({
      from: span.from,
      to: span.to,
      enter: (ref) => {
      switch (ref.name) {
        // 表格本期不渲染：整棵子树原样文本
        case 'Table':
          return false;
        case 'Blockquote':
          addLineDeco(ref.from, ref.to, quoteLine);
          return;
        case 'FencedCode': {
          addLineDeco(ref.from, ref.to, codeLine);
          if (seenFences.has(ref.from)) return;
          seenFences.add(ref.from);
          // 围栏首尾行淡化（始终可见，光标行也一样，不参与豁免）
          const firstLine = doc.lineAt(ref.from);
          const lastLine = doc.lineAt(ref.to);
          ranges.push(fenceDim.range(ref.from, Math.min(firstLine.to, ref.to)));
          if (lastLine.number !== firstLine.number && lastLine.from < ref.to) {
            ranges.push(fenceDim.range(lastLine.from, ref.to));
          }
          return;
        }
      }

      if (onRevealLine(ref.from)) return;

      switch (ref.name) {
        case 'Image': {
          // 纯图 / 裁剪图 ![alt](rel) → 内联缩略图（光标落该行即露源码，复用 reveal）。
          const rel = imageRelSrc(ref.node, doc);
          if (rel) {
            const alt = doc.sliceString(ref.from, ref.to).match(/^!\[([^\]]*)\]/)?.[1] ?? '';
            ranges.push(
              Decoration.replace({
                widget: new ImageWidget(docImageUrl(rel, docIdentity), null, 'left', rel, alt),
              }).range(ref.from, ref.to),
            );
          }
          return false; // 整图节点跳子树（同 Table 行做法）
        }
        case 'HTMLTag':
        case 'HTMLBlock': {
          // 调过大小/对齐的图 <img src width>（可包 <p align>）→ 带尺寸/对齐的缩略图。
          // ViewPlugin 的 replace 装饰不能跨行（CM 硬限制）；工具条生成的 HTML 本就单行，
          // 只有历史/外部手写的多行 <p>\n<img>\n</p> 会跨行——这类保持源码态不渲染（不崩）。
          if (doc.lineAt(ref.from).number !== doc.lineAt(ref.to).number) return;
          const html = doc.sliceString(ref.from, ref.to);
          const img = parseImgHtml(html);
          if (img) {
            ranges.push(
              Decoration.replace({
                widget: new ImageWidget(
                  docImageUrl(img.src, docIdentity),
                  img.width,
                  img.align,
                  img.src,
                  attrValue(html, 'alt') ?? '',
                ),
              }).range(ref.from, ref.to),
            );
            return false;
          }
          return; // 非图 HTML：保持源码态
        }
        case 'HeaderMark':
        case 'QuoteMark':
          ranges.push(hideWithSpace(state, ref.from, ref.to));
          return;
        case 'EmphasisMark':
        case 'StrikethroughMark':
          ranges.push(hide.range(ref.from, ref.to));
          return;
        case 'CodeMark':
          // 围栏的 ``` 走淡化不隐藏，只隐行内代码的反引号
          if (ref.node.parent?.name === 'InlineCode') {
            ranges.push(hide.range(ref.from, ref.to));
          }
          return;
        case 'LinkMark':
        case 'URL':
          // 图片/自动链接的同名节点不动，只处理普通链接
          if (ref.node.parent?.name === 'Link') {
            ranges.push(hide.range(ref.from, ref.to));
          }
          return;
        case 'ListMark': {
          const mark = doc.sliceString(ref.from, ref.to);
          if (!/^[-*+]$/.test(mark)) return; // 有序数字原样保留
          // 任务项的列表符直接隐藏（勾选框已是视觉锚点），普通项换圆点
          if (ref.node.nextSibling?.name === 'Task') {
            ranges.push(hideWithSpace(state, ref.from, ref.to));
          } else {
            ranges.push(bulletDeco.range(ref.from, ref.to));
          }
          return;
        }
        case 'TaskMarker': {
          // 按需 new（同 ImageWidget）：toDOM 捕获的 view 总是当前 view；eq 仍按 checked 去重 DOM 重建
          const checked = /x/i.test(doc.sliceString(ref.from, ref.to));
          ranges.push(Decoration.replace({ widget: new TaskWidget(checked) }).range(ref.from, ref.to));
          return;
        }
        case 'HorizontalRule':
          ranges.push(hrDeco.range(ref.from, ref.to));
          return;
      }
      },
    });
  }

  for (const [lineStart, decos] of lineClasses) {
    for (const deco of decos) ranges.push(deco.range(lineStart));
  }

  return Decoration.set(ranges, true);
}

/** 是否本地相对引用（绝对路径 / 远程 URL / 已是协议 / 含 .. 段越界 → 否，本期只管本地图）。 */
function isLocalRelSrc(src: string): boolean {
  return (
    src !== '' &&
    !src.startsWith('/') &&
    // .. 作为完整路径段才算越界（主进程 realpath 仍兜底）；不误拒文件名里偶含 .. 的（如 a..b.png）
    !src.split('/').includes('..') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(src)
  );
}

/** 取 HTML 标签里某属性的值（双/单引号）。 */
function attrValue(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}=("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

/**
 * 把「调过大小/对齐」落成的 HTML 解析回 {src,width,align}（§五）：大小=<img width>（或 style width:Npx），
 * 对齐=外包 <p|div align>（左=不包）。只认本地相对 src，否则 null（保持源码态）。
 */
export function parseImgHtml(
  html: string,
): { src: string; width: number | null; align: 'left' | 'center' | 'right' } | null {
  const imgTag = /<img\b[^>]*>/i.exec(html)?.[0];
  if (!imgTag) return null;
  const src = attrValue(imgTag, 'src');
  if (!src || !isLocalRelSrc(src)) return null;

  let width: number | null = null;
  const wAttr = attrValue(imgTag, 'width');
  if (wAttr && /^\d+$/.test(wAttr)) {
    width = parseInt(wAttr, 10);
  } else {
    const m = attrValue(imgTag, 'style')?.match(/width:\s*(\d+)px/i);
    if (m) width = parseInt(m[1], 10);
  }

  const alignM = /<(?:p|div)\b[^>]*\balign=["']?(left|center|right)["']?/i.exec(html);
  const align = (alignM?.[1].toLowerCase() ?? 'left') as 'left' | 'center' | 'right';
  return { src, width, align };
}

/**
 * 把 {src,width,align} 写回源码（工具条改大小/对齐用，§五）。承重取舍：
 * 默认形态（无大小 + 左对齐）落纯 markdown `![]()`——哪个渲染器/飞书都认、可移植；
 * 否则落**单行** HTML（大小=<img width>，对齐=外包 <p align>），外部认不得属性时优雅降级成普通图。
 * 单行是为了 reveal 按行生效（光标落该行即露源码可编辑）。
 */
export function buildImageSource(
  src: string,
  width: number | null,
  align: 'left' | 'center' | 'right',
  alt = '',
): string {
  if (width === null && align === 'left') return `![${alt}](${src})`;
  const attrs = `src="${src}"${width !== null ? ` width="${width}"` : ''}${alt ? ` alt="${alt}"` : ''}`;
  const img = `<img ${attrs}>`;
  return align === 'left' ? img : `<p align="${align}">${img}</p>`;
}

/**
 * 从 Image 节点取「文档内相对引用」；只渲染本地相对引用——绝对路径 / 远程 URL（http/data/已是协议）
 * 不经本通道（本期只管本地图），返回 null 让其保持源码态。
 */
function imageRelSrc(node: SyntaxNode, doc: Text): string | null {
  const url = node.getChild('URL');
  if (!url) return null;
  let src = doc.sliceString(url.from, url.to).trim();
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1);
  return isLocalRelSrc(src) ? src : null;
}

/** pos 所在的普通链接的 URL；不在链接内返回 null（⌘点跳转用） */
export function linkUrlAt(state: EditorState, pos: number): string | null {
  for (
    let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 0);
    n;
    n = n.parent
  ) {
    if (n.name === 'Link') {
      const url = n.getChild('URL');
      return url ? state.doc.sliceString(url.from, url.to) : null;
    }
  }
  return null;
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate): void {
      // 末项：大文件语法树是后台增量解析的，解析推进的 update 三个标志全 false，
      // 只能靠树引用变化感知，否则装饰要等下一次用户操作才出现
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = this.build(u.view);
      }
    }
    /** 只算可视区域——超大文件（deck 产物）不全量扫描 */
    build(view: EditorView): DecorationSet {
      return buildDecorationsForRanges(view.state, view.visibleRanges);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * 主题只管装饰层自己的视觉；标题字号/粗斜体等文字样式沿用 MdEditor 的 mdHighlight。
 * 编辑态与渲染态字体字号一致、无任何悬停/选中色块（PRD 明确要求）。
 */
const livePreviewTheme = EditorView.baseTheme({
  // 引用文字颜色由 mdHighlight 的 t.quote 管，这里只管竖线与缩进
  '.cm-livemd-quote': {
    borderLeft: '3px solid var(--border-strong)',
    paddingLeft: '0.8em',
  },
  // 等宽字体栈与码字号对齐项目既有口径（tailwind font-mono / .oru-md code）
  '.cm-livemd-code': {
    backgroundColor: 'var(--bg-sunken)',
    fontFamily: "'SF Mono', ui-monospace, Menlo, Monaco, monospace",
    fontSize: '0.9em',
  },
  '.cm-livemd-fence': {
    color: 'var(--text-tertiary)',
  },
  '.cm-livemd-bullet': {
    color: 'var(--text-secondary)',
  },
  '.cm-livemd-task': {
    accentColor: 'var(--accent)',
    margin: '0 0.4em 0 0',
    verticalAlign: 'middle',
    cursor: 'pointer',
  },
  '.cm-livemd-hr': {
    display: 'inline-block',
    width: '100%',
    verticalAlign: 'middle',
    borderTop: '1px solid var(--border-default)',
  },
  // 图片缩略图：块级容器承载对齐（text-align 由 widget 内联设），图片默认不超容器宽、保持比例。
  // position:relative 让 hover 工具条相对图片定位。
  '.cm-livemd-img': {
    display: 'block',
    position: 'relative',
    margin: '0.2em 0',
  },
  '.cm-livemd-img img': {
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '4px',
    verticalAlign: 'bottom',
  },
  // hover 工具条：默认隐藏，悬停图片才浮现（不抢版面、不打断阅读）。
  // 深墨浮条走 --pop-* 反色 token（设计稿：图片工具条/选段加入对话/网页失败提示统一的悬浮反色小件，2–3px 圆角）。
  '.cm-livemd-img-bar': {
    position: 'absolute',
    top: '8px',
    left: '8px',
    display: 'none',
    alignItems: 'center',
    gap: '1px',
    padding: '2px',
    borderRadius: '3px',
    background: 'var(--pop-bg)',
    border: 'none',
    boxShadow: '0 8px 20px -8px rgba(16,28,34,0.5)',
    zIndex: '2',
  },
  '.cm-livemd-img:hover .cm-livemd-img-bar': {
    display: 'inline-flex',
  },
  '.cm-livemd-img-bar button': {
    minWidth: '22px',
    height: '22px',
    padding: '0 5px',
    border: 'none',
    borderRadius: '2px',
    background: 'transparent',
    color: 'var(--pop-fg-dim)',
    fontSize: '11px',
    cursor: 'pointer',
  },
  '.cm-livemd-img-bar button:hover': {
    background: 'color-mix(in srgb, var(--pop-fg) 12%, transparent)',
    color: 'var(--pop-fg)',
  },
  '.cm-livemd-img-sep': {
    width: '1px',
    height: '14px',
    margin: '0 2px',
    background: 'color-mix(in srgb, var(--pop-fg) 18%, transparent)',
  },
  '.cm-livemd-img-missing': {
    display: 'inline-block',
    padding: '0.3em 0.6em',
    color: 'var(--text-tertiary)',
    fontSize: '0.85em',
    border: '1px dashed var(--border-default)',
    borderRadius: '4px',
  },
});

/* ============================ 表格 block 装饰 ============================ */

const MIN_COL = 48; // 列宽拖拽下限（px）

/** 列宽（纯视图态，不进文档）：key = table.from，随编辑漂移；setColWidth 落一张表的整组宽度。 */
const setColWidth = StateEffect.define<{ from: number; widths: number[] }>();
const colWidthField = StateField.define<Map<number, number[]>>({
  create: () => new Map(),
  update(map, tr) {
    let next = map;
    if (tr.docChanged) {
      next = new Map();
      for (const [key, widths] of map) {
        const mapped = tr.changes.mapPos(key, -1, MapMode.TrackDel);
        if (mapped != null) next.set(mapped, widths); // 表被删则键失效，列宽自然丢弃
      }
    }
    for (const e of tr.effects) {
      if (e.is(setColWidth)) {
        if (next === map) next = new Map(map);
        next.set(e.value.from, e.value.widths);
      }
    }
    return next;
  },
});

/** Tab 跨格续填：提交当前格的同一事务里带上"下一格进编辑"，重建后的 widget 据此自动聚焦。一次性消费。 */
const setPendingEdit = StateEffect.define<{ from: number; row: number; col: number }>();
const pendingEditField = StateField.define<{ from: number; row: number; col: number } | null>({
  create: () => null,
  update(_v, tr) {
    for (const e of tr.effects) if (e.is(setPendingEdit)) return e.value;
    return null; // 任何不携带 setPendingEdit 的事务都清空
  },
});

function cellText(m: TableModel, row: number, col: number): string {
  return (row < 0 ? m.header[col] : m.rows[row]?.[col])?.text ?? '';
}

/** Tab 的下一格：行尾跳下一行行首，表尾返回 null（停）。row<0 为表头。 */
function nextCell(m: TableModel, ref: { row: number; col: number }): { row: number; col: number } | null {
  const cols = m.header.length;
  let { row, col } = ref;
  col += 1;
  if (col >= cols) {
    col = 0;
    row += 1; // 表头(-1)→数据行 0；数据行 r→r+1
  }
  if (row >= 0 && row >= m.rows.length) return null;
  return { row, col };
}

/**
 * 可交互表格 block widget：渲染态每格 renderInline，点格进编辑（DOM 内换 input，不碰文档），
 * 提交才按实时坐标 cellChangeAt 最小写回；增删行列走 serialize 整表重排；列宽纯视图态。
 * eq 按源码文本——源码没变就复用 DOM（编辑过程不被重建打断）。
 */
class TableWidget extends WidgetType {
  readonly kind = 'table';
  constructor(
    readonly from: number,
    readonly model: TableModel,
    readonly src: string,
  ) {
    super();
  }
  override eq(o: TableWidget): boolean {
    return o.src === this.src;
  }
  override ignoreEvent(): boolean {
    return true; // widget 自管点击 / 键盘，不当作编辑器输入
  }
  toDOM(view: EditorView): HTMLElement {
    const m = this.model;
    const cols = m.header.length;
    const wrap = document.createElement('div');
    wrap.className = 'cm-livemd-table';

    const table = document.createElement('table');
    const colgroup = document.createElement('colgroup');
    const colEls: HTMLTableColElement[] = [];
    // 列数变了（插/删列）则旧存宽作废、回退内容自适应——长度不符会让新列在 fixed 布局下塌成 0
    const rawStored = view.state.field(colWidthField, false)?.get(this.from);
    const stored = rawStored && rawStored.length === cols ? rawStored : undefined;
    for (let c = 0; c < cols; c++) {
      const col = document.createElement('col');
      if (stored?.[c] != null) col.style.width = `${stored[c]}px`;
      colgroup.appendChild(col);
      colEls.push(col);
    }
    table.appendChild(colgroup);
    if (stored) table.style.tableLayout = 'fixed';

    // 实时 table.from（block widget 内 posAtDOM 一律回 widget 起点 = table.from）
    const liveFrom = (): number => view.posAtDOM(wrap);

    const structural = (apply: (model: TableModel) => TableModel): void => {
      const t = tableAt(view.state, liveFrom());
      if (!t) return;
      const next = apply(t.model);
      if (next === t.model) return; // 守卫 no-op（删到只剩一行/列）
      view.dispatch({ changes: { from: t.model.from, to: t.lineTo, insert: serialize(next) } });
    };

    const lockWidths = (): void => {
      // 首次（无存宽）锁住内容自然宽，避免进编辑时横向 reflow 闪烁
      colEls.forEach((col, c) => {
        if (!col.style.width) col.style.width = `${Math.round(headerThs[c].getBoundingClientRect().width)}px`;
      });
      table.style.tableLayout = 'fixed';
    };
    const startResize = (colIdx: number, e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      lockWidths();
      const startX = e.clientX;
      const startW = colEls[colIdx].getBoundingClientRect().width;
      const onMove = (ev: MouseEvent): void => {
        colEls[colIdx].style.width = `${Math.max(MIN_COL, startW + ev.clientX - startX)}px`;
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const widths = colEls.map((c) => parseFloat(c.style.width));
        view.dispatch({ effects: setColWidth.of({ from: liveFrom(), widths }) });
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
    const resizeGrip = (colIdx: number): HTMLElement => {
      const grip = document.createElement('div');
      grip.className = 'cm-livemd-col-resize';
      grip.addEventListener('mousedown', (e) => startResize(colIdx, e));
      return grip;
    };

    const holders = new Map<string, HTMLElement>();
    // 同一时刻全表只有一格在编辑：点击另一格时前一格先正常收尾（有改动则提交并随重建在新 DOM
    // 重入目标格，无改动则当场切）。mousedown 全程 preventDefault（阻 CM 吞事件），input blur 不会
    // 先行触发，故收尾必须显式做，不能靠 blur。
    let activeEdit: {
      holder: HTMLElement;
      switchTo: (target: { row: number; col: number }) => void;
    } | null = null;
    const enterEdit = (holder: HTMLElement, ref: { row: number; col: number }, text: string): void => {
      if (holder.classList.contains('cm-livemd-cell-editing')) return; // 幂等：编辑中同一格重复触发直接放行
      holder.classList.add('cm-livemd-cell-editing');
      const input = document.createElement('input');
      input.className = 'cm-livemd-cell-input';
      input.value = text;
      holder.replaceChildren(input);
      let done = false;
      // reenter：'next'（Tab 下一格）/ 指定格（点击切格）/ null（Enter、blur 收尾）
      const finish = (reenter: 'next' | { row: number; col: number } | null): void => {
        if (done) return;
        done = true;
        if (activeEdit?.holder === holder) activeEdit = null;
        const tableFrom = liveFrom(); // = table.from；编辑在表内，dispatch 后 table.from 不变，故续填 widget 能匹配
        const change = cellChangeAt(view.state, tableFrom, ref, input.value, text);
        const target = reenter === 'next' ? nextCell(m, ref) : reenter;
        if (change) {
          // 有改动 → dispatch（docChanged 触发重建）；续填/切格靠 setPendingEdit 在新 DOM 上聚焦目标格
          const effects = [];
          if (target) effects.push(setPendingEdit.of({ from: tableFrom, row: target.row, col: target.col }));
          view.dispatch({ changes: change, effects });
        } else {
          // 无改动 → 不 dispatch（不重建）；本地复原渲染态，直接在存活的 DOM 上切目标格
          fillContent(holder, text);
          if (target) {
            const nh = holders.get(`${target.row}:${target.col}`);
            if (nh) enterEdit(nh, target, cellText(m, target.row, target.col));
          }
        }
      };
      activeEdit = { holder, switchTo: (target) => finish(target) };
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return; // IME 候选未上屏：Enter 是选词，不提交（防吞字）
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(null);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish('next');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done = true;
          if (activeEdit?.holder === holder) activeEdit = null;
          fillContent(holder, text);
        }
      });
      input.addEventListener('blur', () => finish(null));
      input.focus();
      input.select();
    };
    const fillContent = (holder: HTMLElement, text: string): void => {
      holder.classList.remove('cm-livemd-cell-editing');
      holder.innerHTML = renderInline(text);
    };

    const mkTools = (
      buttons: { label: string; title: string; danger?: boolean; act: () => void }[],
      cls: string,
    ): HTMLElement => {
      const div = document.createElement('div');
      div.className = `cm-livemd-tools ${cls}`;
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = b.label;
        btn.title = b.title;
        if (b.danger) btn.className = 'danger';
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          b.act();
        });
        div.appendChild(btn);
      }
      return div;
    };

    const buildCell = (
      tag: 'th' | 'td',
      ref: { row: number; col: number },
      text: string,
    ): HTMLTableCellElement => {
      const cell = document.createElement(tag);
      cell.className = `cm-livemd-td align-${m.aligns[ref.col] ?? 'left'}`;
      const holder = document.createElement('span');
      holder.className = 'cm-livemd-cell-content'; // 主题里 code/链接/空格子行高规则全挂在此类上
      holders.set(`${ref.row}:${ref.col}`, holder);
      fillContent(holder, text);
      cell.appendChild(holder);
      cell.appendChild(resizeGrip(ref.col));
      // mousedown 绑在整个 td/th 而非 holder（内容盒）：td 有 padding/边框，点这些空白处若落不到
      // handler，事件冒泡到 CM 被 ignoreEvent 吞掉、光标留在文档开头——打字污染标题（走查二批该修 3）。
      // resizeGrip / tools 按钮各自 stopPropagation，到这里的一定是格内空白或内容区；
      // 编辑中（input 在）不拦截，交给 input 原生行为与 blur 收尾。
      cell.addEventListener('mousedown', (e) => {
        if (holder.classList.contains('cm-livemd-cell-editing')) return;
        e.preventDefault();
        // 另一格在编辑：先让它正常收尾（有改动提交并随重建重入本格），不直接进编辑
        if (activeEdit) {
          activeEdit.switchTo(ref);
          return;
        }
        enterEdit(holder, ref, text);
      });
      return cell;
    };

    // 表头
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    const headerThs: HTMLTableCellElement[] = [];
    m.header.forEach((c, col) => {
      const th = buildCell('th', { row: -1, col }, c.text);
      const tools: { label: string; title: string; danger?: boolean; act: () => void }[] = [
        { label: '+', title: i18n.t('editor:table.insertColLeft'), act: () => structural((mm) => withColInserted(mm, col)) },
      ];
      if (cols > 1) {
        tools.push({ label: '×', title: i18n.t('editor:table.deleteCol'), danger: true, act: () => structural((mm) => withColDeleted(mm, col)) });
      }
      tools.push({ label: '+', title: i18n.t('editor:table.insertColRight'), act: () => structural((mm) => withColInserted(mm, col + 1)) });
      th.appendChild(mkTools(tools, 'cm-livemd-col-tools'));
      headerThs.push(th);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    // 数据行
    const tbody = document.createElement('tbody');
    m.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      row.forEach((c, col) => {
        const td = buildCell('td', { row: r, col }, c.text);
        if (col === 0) {
          const tools: { label: string; title: string; danger?: boolean; act: () => void }[] = [
            { label: '+', title: i18n.t('editor:table.insertRowAbove'), act: () => structural((mm) => withRowInserted(mm, r)) },
          ];
          if (m.rows.length > 1) {
            tools.push({ label: '×', title: i18n.t('editor:table.deleteRow'), danger: true, act: () => structural((mm) => withRowDeleted(mm, r)) });
          }
          tools.push({ label: '+', title: i18n.t('editor:table.insertRowBelow'), act: () => structural((mm) => withRowInserted(mm, r + 1)) });
          td.appendChild(mkTools(tools, 'cm-livemd-row-tools'));
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    // 首次（无存宽）渲染后测量锁宽，防进编辑横向闪烁
    if (!stored && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (wrap.isConnected) lockWidths();
      });
    }

    // Tab 续填：重建后的 widget 自动把下一格切入编辑。toDOM 时 wrap 尚未挂载，
    // input.focus() 对 detached 节点无效——延到 rAF（挂载后）再 enterEdit。
    const pending = view.state.field(pendingEditField, false);
    if (pending && pending.from === this.from && typeof requestAnimationFrame === 'function') {
      const holder = holders.get(`${pending.row}:${pending.col}`);
      if (holder) {
        requestAnimationFrame(() => {
          if (wrap.isConnected) enterEdit(holder, { row: pending.row, col: pending.col }, cellText(m, pending.row, pending.col));
        });
      }
    }

    return wrap;
  }
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name === 'Table') {
        const to = state.doc.lineAt(ref.to).to; // block replace 要求范围在行边界：取表末行行尾
        const model = parseTable(ref.node, state.doc);
        const src = state.doc.sliceString(ref.from, ref.to);
        ranges.push(
          Decoration.replace({ block: true, widget: new TableWidget(ref.from, model, src) }).range(ref.from, to),
        );
        return false; // 跳子树
      }
    },
  });
  return Decoration.set(ranges, true);
}

/**
 * 表格 block 装饰必须走 StateField（CM6 硬约束：block / 跨行 replace 不能由 ViewPlugin 提供，
 * 否则 @codemirror/view 直接 throw）。与处理 inline/line 装饰的 ViewPlugin 并列两条 Extension。
 * 仅 docChanged / 语法树推进时重扫重建；selectionSet / viewportChanged 不重建——表格装饰与光标无关，
 * 也顺带保证编辑过程中 widget 不被意外重建打断。
 */
export const tableDecorationField = StateField.define<DecorationSet>({
  create: (state) => buildTableDecorations(state),
  update(deco, tr) {
    if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildTableDecorations(tr.state);
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const tableTheme = EditorView.baseTheme({
  '.cm-livemd-table': {
    margin: '0.4em 0',
    overflowX: 'auto',
  },
  '.cm-livemd-table table': {
    borderCollapse: 'separate',
    borderSpacing: '0',
    fontSize: '0.95em',
  },
  '.cm-livemd-td': {
    border: '1px solid var(--border-default)',
    borderLeft: 'none',
    borderTop: 'none',
    padding: '5px 10px',
    minWidth: `${MIN_COL}px`,
    verticalAlign: 'top',
    position: 'relative',
    wordBreak: 'break-word',
  },
  '.cm-livemd-table th.cm-livemd-td': {
    background: 'var(--bg-sunken)',
    fontWeight: '600',
    borderTop: '1px solid var(--border-default)',
  },
  '.cm-livemd-table tr td:first-child, .cm-livemd-table tr th:first-child': {
    borderLeft: '1px solid var(--border-default)',
  },
  '.cm-livemd-td.align-center': { textAlign: 'center' },
  '.cm-livemd-td.align-right': { textAlign: 'right' },
  '.cm-livemd-cell-content': { display: 'block' },
  '.cm-livemd-cell-content:empty::before': { content: '"\\200b"' }, // 空格子保留行高
  '.cm-livemd-cell-content code': {
    fontFamily: "'SF Mono', ui-monospace, Menlo, Monaco, monospace",
    fontSize: '0.88em',
    background: 'var(--bg-sunken)',
    padding: '1px 4px',
    borderRadius: '4px',
  },
  '.cm-livemd-cell-content a': { color: 'var(--accent)' },
  '.cm-livemd-td.cm-livemd-cell-editing, td.cm-livemd-td:has(.cm-livemd-cell-editing)': {},
  '.cm-livemd-cell-editing': { outline: '0' },
  '.cm-livemd-cell-input': {
    font: 'inherit',
    lineHeight: 'inherit',
    color: 'inherit',
    width: '100%',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    margin: '0',
    padding: '0',
    display: 'block',
  },
  '.cm-livemd-col-resize': {
    position: 'absolute',
    top: '0',
    bottom: '0',
    right: '-3px',
    width: '6px',
    cursor: 'col-resize',
    zIndex: '4',
  },
  '.cm-livemd-col-resize:hover': {
    background: 'var(--accent)',
    opacity: '0.4',
  },
  '.cm-livemd-tools': {
    position: 'absolute',
    display: 'none',
    gap: '1px',
    zIndex: '6',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-strong)',
    borderRadius: '6px',
    padding: '2px',
    boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
  },
  '.cm-livemd-col-tools': {
    top: '-32px',
    left: '50%',
    transform: 'translateX(-50%)',
    flexDirection: 'row',
  },
  '.cm-livemd-row-tools': {
    left: '-36px',
    top: '50%',
    transform: 'translateY(-50%)',
    flexDirection: 'column',
  },
  '.cm-livemd-table th:hover .cm-livemd-col-tools, .cm-livemd-col-tools:hover': { display: 'flex' },
  '.cm-livemd-table tbody tr td:first-child:hover .cm-livemd-row-tools, .cm-livemd-row-tools:hover': {
    display: 'flex',
  },
  '.cm-livemd-tools button': {
    width: '22px',
    height: '22px',
    border: 'none',
    borderRadius: '5px',
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: '14px',
    lineHeight: '1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  '.cm-livemd-tools button:hover': { background: 'var(--accent-soft)', color: 'var(--accent)' },
  '.cm-livemd-tools button.danger:hover': { background: 'var(--danger-soft)', color: 'var(--danger)' },
});

/** ⌘/Ctrl+单击链接 → 系统浏览器；普通单击不拦截（落光标进入编辑） */
const linkClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.metaKey || event.ctrlKey)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const url = linkUrlAt(view.state, pos);
    if (!url) return false;
    // 只放行可外开的 scheme——javascript:/data: 等交给系统只会弹"无程序可处理"
    if (!/^(https?:|mailto:)/i.test(url)) return false;
    // 经 main 的 setWindowOpenHandler → openExternal，与旧预览模式同一条路
    window.open(url);
    event.preventDefault();
    return true;
  },
});

export function livePreview(onCrop?: CropHandler | null, docIdentity?: DocIdentity | null): Extension {
  return [
    cropRequestFacet.of(onCrop ?? null), // 裁剪通道绑本 view 实例（多编辑器并存不互相覆盖）
    docIdentityFacet.of(docIdentity ?? null), // 文档身份绑本 view 实例：图片 URL 据此定位，去全局 activeDoc
    livePreviewPlugin,
    livePreviewTheme,
    linkClickHandler,
    tableDecorationField,
    colWidthField,
    pendingEditField,
    tableTheme,
  ];
}
