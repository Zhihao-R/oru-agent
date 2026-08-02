/**
 * 手账正文 markdown 渲染——给 PortraitBlock / AgentSelfBlock 共用。
 *
 * 视觉锚（散文气质，所有标题都比章节 H2 28px 小一档）：
 * - h1 → 衬线 18px 半粗（散文级大段标题）
 * - h2 → sans 11px uppercase 小灰标（段落分组）
 * - h3 → 衬线 16px 半粗（更细粒度）
 * - p / li → 衬线 17px 行高 1.85
 * - strong / em / a / code 沿用手账主色
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkDialect } from '@/lib/markdownDialect';

export function MemoryMarkdown({ source }: { source: string }) {
  return (
    <div className="font-serif text-[17px] leading-[1.85] text-text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkDialect, remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h3 className="mb-2 mt-7 font-serif text-[18px] font-semibold tracking-tight text-text-primary first:mt-0">
              {children}
            </h3>
          ),
          h2: ({ children }) => (
            <h4 className="mb-2 mt-6 font-sans text-[11px] font-semibold uppercase tracking-[0.14em] text-text-tertiary first:mt-0">
              {children}
            </h4>
          ),
          h3: ({ children }) => (
            <h5 className="mb-1.5 mt-5 font-serif text-[16px] font-semibold tracking-tight text-text-primary first:mt-0">
              {children}
            </h5>
          ),
          p: ({ children }) => <p className="mb-4 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-4 ml-5 list-disc space-y-1 last:mb-0 marker:text-text-tertiary">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-4 ml-5 list-decimal space-y-1 last:mb-0 marker:text-text-tertiary">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="leading-[1.75]">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-text-primary">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline decoration-[var(--accent-line,rgba(196,90,43,0.32))] underline-offset-2 hover:decoration-accent"
            >
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[0.85em] text-text-primary">
              {children}
            </code>
          ),
          hr: () => <hr className="my-6 h-px border-0 bg-border" />,
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-l-2 border-border pl-4 italic text-text-secondary">
              {children}
            </blockquote>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
