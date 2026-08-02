import { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import { remarkDialect } from '@/lib/markdownDialect';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { docImageUrl, type DocIdentity } from '@/lib/docImageUrl';

/**
 * 书本风 Markdown 渲染的单一来源——聊天（ChatMarkdown）与导出（renderToStaticMarkup）共用。
 * 插件栈 / components / 标题 id 一处定义，导出复用同一栈以保证「所见即所得」、无第二套实现漂移
 * （技术方案 §三）。样式见 src/index.css 的 .oru-chat-md 块。
 *
 * 数学公式只认 $$…$$（行内与独立块均可）；单 $ 故意关掉——中文里"$100到$200"这类金额没有空格隔断，
 * 会被误判成公式，正文里金额比公式高频得多。
 */

// 裸 URL（锚文本就是地址本身）压成域名时返回该域名，否则回 null（调用方回退原文）。
// 模型在「来源： [1] https://…」里直接吐完整地址，展开后撑屏换行；域名才是判断来源的
// 最小单位。锚文本与 href 可能差个协议头——GFM 给无协议裸链（www.x.com）补 http://——
// 故去协议头后比对，带不带协议的裸链统一覆盖；www. 前缀无信息一并去掉。
function bareUrlDomain(href: string | undefined, children: unknown): string | null {
  if (!href || typeof children !== 'string') return null;
  const strip = (s: string): string => s.replace(/^https?:\/\//, '');
  if (strip(children) !== strip(href)) return null;
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// hast 节点的最小结构（只取遍历/读写要用的字段）
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { id?: string; [k: string]: unknown };
  children?: HastNode[];
}

// 给标题补 id，让文档内 [跳到某节](#某标题) 锚点可用——react-markdown 默认标题不带 id。
// 自包含轻量 slug（零依赖，不引 rehype-slug）：目标是文档内部锚点自洽，非 GitHub 兼容。
// 保留 Unicode 字母/数字（中文标题照常），空白转连字符，同名标题加 -1/-2 去重。
function rehypeHeadingIds() {
  const slugify = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-') || 'section';
  const textOf = (node: HastNode): string =>
    node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');
  return (tree: HastNode): void => {
    const seen = new Map<string, number>();
    const walk = (node: HastNode): void => {
      if (node.type === 'element' && node.tagName && /^h[1-6]$/.test(node.tagName)) {
        const props = (node.properties ??= {});
        if (!props.id) {
          const base = slugify(textOf(node));
          const n = seen.get(base) ?? 0;
          seen.set(base, n + 1);
          props.id = n ? `${base}-${n}` : base;
        }
      }
      (node.children ?? []).forEach(walk);
    };
    walk(tree);
  };
}

// 只有本地相对引用才改写成 oru-doc-img://（外链 / data URI / 锚点不碰，与 inlineAssets.isLocalRef 同口径）。
function isLocalImageRef(src: string): boolean {
  return !/^(https?:)?\/\//i.test(src) && !src.startsWith('data:') && !src.startsWith('#');
}

// react-markdown 把 src 交给 components 前已对其做过一次 percent 编码（中文文件名→%E6…）。docImageUrl 会
// 再逐段 encodeURIComponent，故这里先逐段解码还原成原始 ref，避免双重编码（主进程只解一次、找不到图）。
// 编辑器实时预览走 CM 语法树拿的是原始 ref、无此问题——导出经 react-markdown 才需这步。
function decodeRmSrc(src: string): string {
  try {
    return src.split('/').map(decodeURIComponent).join('/');
  } catch {
    return src; // 畸形编码：原样交给 docImageUrl，宁可不改写也不抛
  }
}

// 给 pre 内的 code 打块级标记，让 code 组件能区分行内/块（react-markdown v9 去掉了 inline prop）。
// 仅聊天端（传 inlineCode 时）挂载此插件——导出端不跑，导出 HTML 不留 data 垃圾属性。
function rehypeMarkBlockCode() {
  return (tree: HastNode): void => {
    const walk = (node: HastNode): void => {
      if (node.type === 'element' && node.tagName === 'pre') {
        for (const child of node.children ?? []) {
          if (child.type === 'element' && child.tagName === 'code') {
            (child.properties ??= {})['data-block-code'] = true;
          }
        }
      }
      (node.children ?? []).forEach(walk);
    };
    walk(tree);
  };
}

// components 映射工厂：抽到组件外、经 useMemo 持有，让 p/code 等自定义组件跨 render 身份稳定
// （稳定的必要性见 MarkdownDoc 内注释）。
function markdownComponents({
  docIdentity,
  inlineCode,
  paragraph,
}: {
  docIdentity: DocIdentity | null;
  inlineCode?: (text: string) => JSX.Element | null;
  paragraph?: (children: React.ReactNode) => JSX.Element | null;
}): Components {
  return {
    // 页内锚点（#标题 / 脚注）留在窗口内；外链补 target=_blank 走 main 的
    // setWindowOpenHandler → openExternal。即便漏补，主进程 will-navigate 兜底
    // 也会拦下整页导航（navigationGuard），这里 target 是第一道、主进程是结构性兜底
    // node：react-markdown 把 hast 节点也传进来，丢弃不外泄——导出物是要发出去的文件，
    // 不能在每个标签上留 node="[object Object]" 的垃圾属性（屏幕端不可见但导出端是脏 HTML）。
    a: ({ href, children, node: _n, ...props }) => {
      if (href?.startsWith('#')) return <a href={href} {...props}>{children}</a>;
      // 裸 URL 压成域名，完整地址留 title 悬浮（判据见 bareUrlDomain）
      const domain = bareUrlDomain(href, children);
      return (
        <a
          href={href}
          {...props}
          title={domain ? href : undefined}
          target="_blank"
          rel="noreferrer"
        >
          {domain ?? children}
        </a>
      );
    },
    // 导出端把文档内相对图引用改写成 oru-doc-img:// URL（docIdentity 在才改）；聊天端透传原 src
    img: ({ src, node: _n, ...props }) =>
      docIdentity && typeof src === 'string' && isLocalImageRef(src) ? (
        <img src={docImageUrl(decodeRmSrc(src), docIdentity)} {...props} />
      ) : (
        <img src={src} {...props} />
      ),
    // 任务清单 checkbox 只读：历史/导出皆静态，勾选无处回写，禁用免假交互
    input: ({ node: _n, ...props }) => <input {...props} disabled />,
    // 行内 code 的替换钩子（仅聊天端）：块级 code（data-block-code 标记）与非纯文本内容不碰
    ...(inlineCode
      ? {
          code: ({ children, node: _n, ...props }: React.ComponentProps<'code'> & { node?: unknown }) => {
            const { 'data-block-code': isBlock, ...rest } = props as { 'data-block-code'?: boolean } &
              React.ComponentProps<'code'>;
            if (!isBlock && typeof children === 'string') {
              const replaced = inlineCode(children);
              if (replaced) return replaced;
            }
            return <code {...rest}>{children}</code>;
          },
        }
      : {}),
    // 段落替换钩子（仅聊天端）：段落级接管（如来源段收起），返回 null 走默认 <p>
    ...(paragraph
      ? {
          p: ({ children, node: _n, ...props }: React.ComponentProps<'p'> & { node?: unknown }) =>
            paragraph(children) ?? <p {...props}>{children}</p>,
        }
      : {}),
    // 宽表横向滚动，避免撑破容器
    table: ({ children, node: _n, ...props }) => (
      <div className="oru-chat-md-table-wrap">
        <table {...props}>{children}</table>
      </div>
    ),
  };
}

/**
 * 共享渲染组件。`docIdentity` 仅导出端传入：此时文档内相对图引用被改写成 oru-doc-img:// URL，
 * 供 HTML 出口内联（parseDocImageUrl 往返）/ PDF 出口经协议加载。聊天端不传 → 图引用原样（聊天图非本地 assets）。
 * `inlineCode` 仅聊天端传入：行内 code 的替换渲染钩子（路径 chip 化）；返回 null 走默认渲染。
 * `paragraph` 仅聊天端传入：段落级替换钩子（聊天用于「来源：」段收起）；返回 null 走默认 <p>。
 * 导出端不传 → 渲染管线与产物字节完全不变。
 */
export function MarkdownDoc({
  content,
  docIdentity = null,
  inlineCode,
  paragraph,
}: {
  content: string;
  docIdentity?: DocIdentity | null;
  inlineCode?: (text: string) => JSX.Element | null;
  paragraph?: (children: React.ReactNode) => JSX.Element | null;
}): JSX.Element {
  // components 必须跨 render 保持身份稳定：内联新建会让 p/code 等自定义组件的函数身份
  // 每次变化，React 按类型 reconcile 时重挂载子树——SourcesFootnote 的展开态会在父级
  // 重渲染（流式期间消息列表整体重渲染是常态）时被重置。聊天端传入的钩子都是模块级
  // 常量，依赖数组实际只在挂载时求值一次。
  const components = useMemo(
    () => markdownComponents({ docIdentity, inlineCode, paragraph }),
    [docIdentity, inlineCode, paragraph],
  );
  return (
    <div className="oru-chat-md">
      <ReactMarkdown
        // breaks 恒开：单换行视为换行（书本风的既定排版；导出物的所见即所得基准就是这套 .oru-chat-md）
        remarkPlugins={[remarkDialect, remarkGfm, remarkBreaks, [remarkMath, { singleDollarTextMath: false }]]}
        // highlight 必须在 katex 前，且不可开 detect——```math 围栏块两个插件都认，现序下 highlight 因
        // lowlight 无 math 语言而跳过、katex 接手；倒序或 detect 会抢。
        // rehypeHeadingIds 末位：给标题补 id，供文档内 #锚点跳转与导出后的目录链接。
        rehypePlugins={
          inlineCode
            ? [rehypeHighlight, rehypeKatex, rehypeHeadingIds, rehypeMarkBlockCode]
            : [rehypeHighlight, rehypeKatex, rehypeHeadingIds]
        }
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
