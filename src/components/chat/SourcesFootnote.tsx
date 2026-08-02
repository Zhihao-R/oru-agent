import { Children, isValidElement, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * 聊天「来源」段收起（2026-07-28 拍板）：上网回答末尾的来源行默认收成「来源 · N」轻量条，
 * 点开为小字列表、按 [n] 编号拆行。锚点是段首「来源：」——提示词（prompts/webSearch.ts）
 * 既定引用规范，模型稳定输出，识别与拆行全在业务代码、不对模型加新约束；导出端不挂本
 * hook，来源段照常完整渲染（纸面无交互）。
 */

// 「来源」在此是匹配模型输出的段首哨兵（数据格式，CLAUDE.md 四类边界），非 UI 文案，
// i18n-exempt；sources? 兼容模型偶发的英文写法。
const SOURCES_PREFIX = /^\s*(?:来源|sources?)\s*[:：]\s*/i;

function isLink(node: ReactNode): boolean {
  return isValidElement(node) && typeof (node.props as { href?: unknown }).href === 'string';
}

// 按 [n] 编号标记拆行；<br>（模型真换了行）也当行界。拆不出多行就整段一行，天然兜底。
function splitLines(nodes: ReactNode[]): ReactNode[][] {
  const lines: ReactNode[][] = [];
  let current: ReactNode[] = [];
  const flush = () => {
    if (current.some((n) => typeof n !== 'string' || n.trim())) lines.push(current);
    current = [];
  };
  for (const node of nodes) {
    if (isValidElement(node) && node.type === 'br') {
      flush();
      continue;
    }
    if (typeof node !== 'string') {
      current.push(node);
      continue;
    }
    for (const part of node.split(/(?=\[\d+\])/)) {
      if (/^\[\d+\]/.test(part)) flush();
      if (part) current.push(part);
    }
  }
  flush();
  return lines;
}

/**
 * 来源段判定 + 接管入口：段首命中「来源：」且段内有链接才收起，否则回 null 走默认 <p>。
 * 前缀在此剥掉（收起条上已有「来源」字样，列表里不重复）——下游只处理纯来源内容。
 */
export function renderSourcesParagraph(children: ReactNode): JSX.Element | null {
  const nodes = Children.toArray(children);
  const first = nodes[0];
  if (typeof first !== 'string' || !SOURCES_PREFIX.test(first)) return null;
  if (!nodes.some(isLink)) return null;
  return <SourcesFootnote nodes={[first.replace(SOURCES_PREFIX, ''), ...nodes.slice(1)]} />;
}

function SourcesFootnote({ nodes }: { nodes: ReactNode[] }): JSX.Element {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="rounded-xs px-1.5 py-0.5 text-xs text-text-tertiary transition-colors duration-150 hover:bg-hover hover:text-text-secondary"
      >
        {t('sources.toggle', { count: nodes.filter(isLink).length })}
      </button>
      {expanded ? (
        <div className="mt-1 space-y-0.5 px-1.5 text-xs text-text-tertiary">
          {splitLines(nodes).map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
