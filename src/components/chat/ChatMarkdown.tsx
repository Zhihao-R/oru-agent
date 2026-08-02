import { MarkdownDoc } from '@/lib/markdownRender';
import { InlinePathChip } from './InlinePathChip';
import { renderSourcesParagraph } from './SourcesFootnote';

/**
 * 聊天专用 markdown 渲染：书本风，比 .oru-md 更轻。
 * 渲染逻辑（插件栈 / components / 标题 id）已抽到 src/lib/markdownRender 的 MarkdownDoc——
 * 聊天与导出共用单一来源、无第二套实现漂移（技术方案 §三）。本组件只保留聊天侧的入口与 prop 名。
 * 行内 code 命中「项目内真实存在的可开文件路径」时升级成路径 chip；「来源：」段默认收起
 * （SourcesFootnote）——两者都仅聊天端，导出不受影响。
 */
const renderInlineCode = (text: string): JSX.Element | null => <InlinePathChip text={text} />;

export function ChatMarkdown({ source }: { source: string }): JSX.Element {
  return (
    <MarkdownDoc content={source} inlineCode={renderInlineCode} paragraph={renderSourcesParagraph} />
  );
}
