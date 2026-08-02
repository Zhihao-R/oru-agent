/**
 * 聊天「来源」段默认收起（2026-07-28 拍板：收起 + 点开小字列表，提示词零改动）。
 * 锚点是段首「来源：」——提示词 prompts/webSearch.ts 既定引用规范，模型稳定输出，
 * 新旧消息通吃；拆行按 [n] 编号在业务代码里做，不对模型加新约束。
 * 导出端（MarkdownDoc 不传 hook）必须照常完整渲染——纸面无交互。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { MarkdownDoc } from '@/lib/markdownRender';

afterEach(cleanup);

const MSG =
  '正文观察一段。\n\n来源： [1] https://www.36kr.com/p/1 [2] https://gelonghui.com/p/2 [3] https://news.qq.com/a/3';

describe('聊天来源段收起', () => {
  it('默认收起：只见「来源 · N」条，链接不上屏', () => {
    const { container, getByRole } = render(<ChatMarkdown source={MSG} />);
    expect(container.querySelectorAll('a').length).toBe(0);
    const btn = getByRole('button');
    expect(btn.textContent).toBe('来源 · 3');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('点开：按 [n] 编号拆行的小字列表，域名压缩照常、「来源：」前缀不重复', () => {
    const { container, getByRole } = render(<ChatMarkdown source={MSG} />);
    fireEvent.click(getByRole('button'));
    const links = container.querySelectorAll('a');
    expect(links.length).toBe(3);
    expect(links[0].textContent).toBe('36kr.com');
    // 每条来源一行：展开块的每个直接子元素恰含一个链接
    const list = getByRole('button').nextElementSibling!;
    expect(list.children.length).toBe(3);
    for (const line of list.children) {
      expect(line.querySelectorAll('a').length).toBe(1);
    }
    // 前缀已剥掉（条上是「来源 · 3」，正文里不再出现「来源：」）
    expect(container.textContent).not.toContain('来源：');
    // 再点收起
    fireEvent.click(getByRole('button'));
    expect(container.querySelectorAll('a').length).toBe(0);
  });

  it('父级重渲染不丢展开态（流式期间消息列表整体重渲染是常态）', () => {
    // 回归：components 映射若每次 render 内联新建，p 组件函数身份变化会让 React
    // 重挂载 SourcesFootnote，expanded 本地态被重置——点开的列表在下一个流式 tick 弹回收起
    const { container, getByRole, rerender } = render(<ChatMarkdown source={MSG} />);
    fireEvent.click(getByRole('button'));
    expect(container.querySelectorAll('a').length).toBe(3);
    rerender(<ChatMarkdown source={MSG} />);
    expect(container.querySelectorAll('a').length).toBe(3);
    expect(getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });

  it('普通段落不受影响，仍走默认 <p> 渲染', () => {
    const { container } = render(<ChatMarkdown source={'普通段落，带 [链接](https://example.com)。'} />);
    expect(container.querySelector('p')).not.toBeNull();
    expect(container.querySelectorAll('a').length).toBe(1);
    expect(container.querySelector('button')).toBeNull();
  });

  it('无链接的「来源：」段不收起（守卫：没得展开就别藏）', () => {
    const { container } = render(<ChatMarkdown source={'来源：见上文讨论。'} />);
    expect(container.querySelector('p')?.textContent).toBe('来源：见上文讨论。');
    expect(container.querySelector('button')).toBeNull();
  });

  it('导出端 MarkdownDoc 不传 hook：来源段完整渲染、无收起交互', () => {
    const { container } = render(<MarkdownDoc content={MSG} />);
    expect(container.querySelectorAll('a').length).toBe(3);
    expect(container.textContent).toContain('来源：');
    expect(container.querySelector('button')).toBeNull();
  });
});
