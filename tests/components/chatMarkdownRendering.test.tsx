/**
 * 回归：ChatMarkdown 渲染缺口修复（2026-06-23）
 * - 标题补 id：文档内 [..](#标题) 锚点可跳转（原缺 id，死链）
 * - 任务清单 checkbox 只读：聊天是历史记录，勾选无处回写，禁用免假交互
 * - 宽表横向滚动容器：避免撑破气泡
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';

afterEach(cleanup);

describe('标题锚点 id', () => {
  it('标题生成可跳转的 id（中文照常保留）', () => {
    const { container } = render(<ChatMarkdown source={'# 安装步骤\n\n正文'} />);
    const h1 = container.querySelector('h1')!;
    expect(h1.id).toBe('安装步骤');
  });

  it('同名标题去重加序号', () => {
    const { container } = render(<ChatMarkdown source={'## 小结\n\na\n\n## 小结\n\nb'} />);
    const ids = Array.from(container.querySelectorAll('h2')).map((h) => h.id);
    expect(ids).toEqual(['小结', '小结-1']);
  });

  it('页内锚点链接指向真实存在的标题 id（不再是死链）', () => {
    const { container } = render(<ChatMarkdown source={'[去看](#小结)\n\n## 小结\n\n正文'} />);
    // href 经 react-markdown 百分号编码，浏览器跳转时会解码后匹配 id
    const href = container.querySelector('a')!.getAttribute('href')!;
    expect(decodeURIComponent(href)).toBe('#小结');
    expect(container.querySelector('h2')!.id).toBe('小结'); // 解码后 href 与 id 对得上 = 可跳转
  });
});

describe('任务清单 checkbox 只读', () => {
  it('checkbox 渲染为 disabled', () => {
    const { container } = render(<ChatMarkdown source={'- [x] 已完成\n- [ ] 待办'} />);
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    for (const box of boxes) expect((box as HTMLInputElement).disabled).toBe(true);
  });
});

describe('宽表横向滚动', () => {
  it('table 被包进可横向滚动的容器', () => {
    const { container } = render(
      <ChatMarkdown source={'| a | b |\n| - | - |\n| 1 | 2 |'} />,
    );
    const wrap = container.querySelector('.oru-chat-md-table-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelector('table')).not.toBeNull();
  });
});
