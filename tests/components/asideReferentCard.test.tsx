/** @vitest-environment jsdom */
/**
 * 指代卡（AsideReferentCard）——kind:'aside-referent' 消息从 asideReferent payload 还原：
 * - 文字类（selection/message/deck-page/带文案 control）：来源行 + 引文预览，点击展开/收起；
 * - 画面类（blank/无文案控件）：附件缩略图 + 来源行；无图降级只剩来源行；
 * - message.text 是给模型的回放形态，任何档都不展示；
 * - ChatMessage 分支：aside-referent 渲染为指代卡而非用户气泡（payload 缺失也不崩）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage as Msg } from '@shared/types';
import { AsideReferentCard } from '@/components/chat/AsideReferentCard';
import { ChatMessage } from '@/components/chat/ChatMessage';

function makeMsg(overrides: Partial<Msg>): Msg {
  return {
    id: 'm1',
    conversationId: 'cnv',
    role: 'user',
    kind: 'aside-referent',
    text: '（给模型的回放形态，不该上屏）',
    toolCalls: [],
    createdAt: 1000,
    done: true,
    ...overrides,
  };
}

afterEach(cleanup);

describe('AsideReferentCard', () => {
  it('文字类：来源行 + 引文预览，点击展开/收起（aria-expanded 翻转）', () => {
    const msg = makeMsg({
      asideReferent: { type: 'selection', label: '一段选中文字', text: '这页的配色有点闷，灰得不像我们的产品。' },
    });
    render(<AsideReferentCard message={msg} />);
    expect(screen.getByText('一段选中文字')).toBeTruthy();
    const quote = screen.getByRole('button', { expanded: false });
    expect(quote.textContent).toContain('这页的配色有点闷');
    // 回放形态的 text 不上屏
    expect(screen.queryByText(/回放形态/)).toBeNull();
    fireEvent.click(quote);
    expect(quote.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(quote);
    expect(quote.getAttribute('aria-expanded')).toBe('false');
  });

  it('画面类（blank + 截图附件）：缩略图用 displayUrl + 来源行；无附件降级只剩来源行', () => {
    const shot = makeMsg({
      asideReferent: { type: 'blank', label: '一处空白' },
      attachments: [
        {
          kind: 'image',
          relPath: 'conv-images/cnv/m1-0.png',
          mediaType: 'image/png',
          bytes: 8,
          filename: 'aside-screenshot.png',
          displayUrl: 'oru-conv-img://local/shots/m1-0.png',
        },
      ],
    });
    render(<AsideReferentCard message={shot} />);
    expect(screen.getByText('一处空白')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('src')).toBe('oru-conv-img://local/shots/m1-0.png');
    cleanup();
    // 无图降级（非 vision / 截图失败）：来源行仍在、无图无引文
    render(<AsideReferentCard message={makeMsg({ asideReferent: { type: 'blank', label: '一处空白' } })} />);
    expect(screen.getByText('一处空白')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('ChatMessage 的 aside-referent 分支', () => {
  it('渲染为指代卡（带 data-message-id 锚点），不渲染成用户气泡', () => {
    const msg = makeMsg({
      asideReferent: { type: 'message', label: '一条消息', messageId: 'mx', text: '原文', context: '前后文' },
    });
    const { container } = render(<ChatMessage message={msg} />);
    expect(container.querySelector('[data-message-id="m1"]')).toBeTruthy();
    expect(screen.getByText('一条消息')).toBeTruthy();
    // 用户气泡的回放文本不出现
    expect(screen.queryByText(/回放形态/)).toBeNull();
  });

  it('payload 缺失（脏数据）→ 退化为占位来源行，不崩', () => {
    render(<ChatMessage message={makeMsg({})} />);
    expect(screen.getByText('一次指认')).toBeTruthy();
  });
});
