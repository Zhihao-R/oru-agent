/**
 * 回归：Markdown 里的链接必须带 target="_blank"
 *
 * target="_blank" 是第一道防线：让外链走 main 的 setWindowOpenHandler → openExternal。
 * 历史 bug：ChatMarkdown / MdPreview 没给 a 加 target，聊天页和编辑器预览
 * 点外链都会带跑窗口（2026-06-11 发现并修复）。
 * 2026-06-23 起主进程另有 will-navigate 结构性兜底（见 window/navigationGuard），
 * 即便漏补 target 也拦得住整页导航；此处仍校验 target 以保第一道防线不退化。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';

afterEach(cleanup);

// 显式链接 + GFM 裸链接自动识别，两种生成路径都要覆盖
const SOURCE = '看 [文档](https://example.com/docs)，裸链接 https://oru.app 也算。';

function expectAllLinksOpenExternally(container: HTMLElement) {
  const links = container.querySelectorAll('a');
  expect(links.length).toBe(2);
  for (const a of links) {
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noreferrer');
  }
}

describe('Markdown 链接外开', () => {
  it('ChatMarkdown：所有链接 target=_blank，走主进程外开通道', () => {
    const { container } = render(<ChatMarkdown source={SOURCE} />);
    expectAllLinksOpenExternally(container);
  });
});

describe('来源裸链接压成域名', () => {
  it('裸 URL 只显示域名（去 www.），完整地址进 title 悬浮', () => {
    const { container, getByRole } = render(
      <ChatMarkdown source="来源： [1] https://www.iaea.org/zh/fukushima2011" />,
    );
    fireEvent.click(getByRole('button')); // 来源段默认收起（chatSourcesCollapse），点开再验域名压缩
    const a = container.querySelector('a')!;
    expect(a.textContent).toBe('iaea.org');
    expect(a.getAttribute('title')).toBe('https://www.iaea.org/zh/fukushima2011');
  });

  it('显式锚文本不被改写（只压裸 URL）', () => {
    const { container } = render(<ChatMarkdown source="看 [文档](https://example.com/docs)" />);
    const a = container.querySelector('a')!;
    expect(a.textContent).toBe('文档');
    expect(a.getAttribute('title')).toBeNull();
  });

  // GFM 给无协议裸链补 http://，href 与锚文本差个协议头；判据去协议头后比对才不漏
  it('无协议裸链（www. 开头）也压成域名', () => {
    const { container, getByRole } = render(
      <ChatMarkdown source="来源： www.iaea.org/zh/fukushima2011" />,
    );
    fireEvent.click(getByRole('button')); // 来源段默认收起（chatSourcesCollapse），点开再验域名压缩
    const a = container.querySelector('a')!;
    expect(a.textContent).toBe('iaea.org');
    expect(a.getAttribute('title')).toBe('http://www.iaea.org/zh/fukushima2011');
  });

  // 锚文本恰是裸 URL 就压，不论来自 autolink 还是手写 [url](url)——可见的长 URL 才是要消除的眼疾
  it('手写 [url](url) 锚文本即 URL 时同样压成域名', () => {
    const { container } = render(
      <ChatMarkdown source="[https://example.com/a/b](https://example.com/a/b)" />,
    );
    const a = container.querySelector('a')!;
    expect(a.textContent).toBe('example.com');
  });
});
