/**
 * 回归：GFM 脚注与数学公式渲染（2026-06-11 新增能力）
 *
 * - 脚注：remark-gfm 解析，要渲染出脚注区（section.footnotes）与正文里的跳转锚点；
 *   脚注锚点是页内跳转，不得带 target=_blank——否则会走主进程 openExternal 把
 *   file:// 地址甩给系统浏览器。
 * - 数学：只认 $$…$$（singleDollarTextMath 关闭）。单 $ 在中文里没有空格隔断，
 *   "$100到$200"这类金额会被误判成公式——金额在聊天里比公式高频得多。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';

afterEach(cleanup);

describe('GFM 脚注', () => {
  const SOURCE = '高反主要看心肺底子[^1]。\n\n[^1]: 也和上升速度有关。';

  it('渲染出脚注区与正文跳转锚点', () => {
    const { container } = render(<ChatMarkdown source={SOURCE} />);
    expect(container.querySelector('section[data-footnotes]')).not.toBeNull();
    expect(container.querySelector('sup a[href^="#"]')).not.toBeNull();
  });

  it('脚注锚点是页内跳转，不带 target=_blank', () => {
    const { container } = render(<ChatMarkdown source={SOURCE} />);
    const anchors = container.querySelectorAll('a[href^="#"]');
    // 先钉住锚点确实渲染出来了——空集合跑空循环是假绿
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute('target')).toBeNull();
    }
  });
});

describe('数学公式', () => {
  it('$$…$$ 渲染为 KaTeX（行内与独立块）', () => {
    const inline = render(<ChatMarkdown source={'温度 $$T_0 - 6$$ 度。'} />);
    expect(inline.container.querySelector('.katex')).not.toBeNull();
    cleanup();
    const block = render(<ChatMarkdown source={'$$\nT = T_0 - 6\n$$'} />);
    expect(block.container.querySelector('.katex-display')).not.toBeNull();
  });

  it('单 $ 不解析为公式——中文金额不得被吃掉', () => {
    const { container } = render(<ChatMarkdown source={'这双鞋$100到$200之间。'} />);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$100到$200');
  });
});
