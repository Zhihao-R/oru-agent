/**
 * 回归：软换行（remark-breaks）只开聊天（2026-06-11 新增）
 *
 * 聊天渲染的是模型说话——"**小标题**⏎正文"这类单换行是它的本意，标准 Markdown
 * 会把单换行吞成空格、粘成一行（实测 5% 历史消息中招）。md 编辑器（CodeMirror
 * 实时预览）渲染 .md 文件，文本即源码、天然维持标准语义，不经 remark 管线。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';

afterEach(cleanup);

const SOURCE = '**最推荐 · 大峰**\n川西入门头号选择。';

describe('软换行', () => {
  it('ChatMarkdown：单换行渲染为 <br>', () => {
    const { container } = render(<ChatMarkdown source={SOURCE} />);
    expect(container.querySelector('p > br')).not.toBeNull();
  });
});
