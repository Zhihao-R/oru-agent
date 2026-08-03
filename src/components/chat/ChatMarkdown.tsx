import { memo } from 'react';
import { MarkdownDoc } from '@/lib/markdownRender';
import { InlinePathChip } from './InlinePathChip';
import { renderSourcesParagraph } from './SourcesFootnote';

/**
 * 聊天专用 markdown 渲染：书本风，比 .oru-md 更轻。
 * 渲染逻辑（插件栈 / components / 标题 id）已抽到 src/lib/markdownRender 的 MarkdownDoc——
 * 聊天与导出共用单一来源、无第二套实现漂移（技术方案 §三）。本组件只保留聊天侧的入口与 prop 名。
 * 行内 code 命中「项目内真实存在的可开文件路径」时升级成路径 chip；「来源：」段默认收起
 * （SourcesFootnote）——两者都仅聊天端，导出不受影响。
 *
 * memo：一条消息的 source 内容不变即跳过整段 react-markdown 重 parse + rehype-highlight 高亮——
 * 治「列表每次重渲染都把当前界面全部消息重新解析一遍」的 CPU 风暴（见 docs/plans/2026-08-03-…）。
 * 生效前提：传给 MarkdownDoc 的 inlineCode / paragraph 必须是跨渲染稳定的引用（下方模块级常量，
 * 勿内联进组件体，内联会生成新引用使浅比较失效）。
 */
const renderInlineCode = (text: string): JSX.Element | null => <InlinePathChip text={text} />;

export const ChatMarkdown = memo(function ChatMarkdown({ source }: { source: string }): JSX.Element {
  return (
    <MarkdownDoc content={source} inlineCode={renderInlineCode} paragraph={renderSourcesParagraph} />
  );
});
