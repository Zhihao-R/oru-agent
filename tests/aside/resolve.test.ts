/** @vitest-environment jsdom */
/**
 * 主窗口 ⌥点的指代解析（src/aside/resolve.ts）：四档优先级（选区 > 消息 > 控件 > 空白）、
 * label 措辞、上下文切取。文件树行不注册 data-message-id——⌥点它必须落 blank 档。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/types';
import { resolveAsideReferent, type AsideResolveArgs } from '@/aside/resolve';

function msg(id: string, role: ChatMessage['role'], text: string, extra?: Partial<ChatMessage>): ChatMessage {
  return {
    id,
    conversationId: 'cnv_1',
    role,
    text,
    toolCalls: [],
    createdAt: 1,
    done: true,
    ...extra,
  };
}

// 八条消息：m4 是被点的那条；m3 是 UI 隐藏的系统旁白——不占前后文名额；
// m0 在"可见邻居前后各 2 条"的窗口外；m6 是流式中的半截（done: false）
const LIST: ChatMessage[] = [
  msg('m0', 'user', '窗口外的远古消息'),
  msg('m1', 'user', '前文一'),
  msg('m2', 'assistant', '前文二'),
  msg('m3', 'user', '（系统记：用户拒绝了提案）'),
  msg('m4', 'assistant', '被指认的这条消息正文'),
  msg('m5', 'user', '后文一'),
  msg('m6', 'assistant', '流式半截', { done: false }),
  msg('m7', 'assistant', '窗口外的后续'),
];

function findInList(messageId: string): { list: readonly ChatMessage[]; index: number } | null {
  const index = LIST.findIndex((m) => m.id === messageId);
  return index >= 0 ? { list: LIST, index } : null;
}

function resolve(overrides: Partial<AsideResolveArgs>) {
  return resolveAsideReferent({
    target: null,
    selectionText: '',
    selectionAnchorEl: null,
    getEditorSelection: () => '',
    findMessage: () => null,
    getActiveMessages: () => [],
    ...overrides,
  });
}

beforeEach(() => {
  document.body.innerHTML = `
    <section data-chat-area>
      <div data-message-id="m4">
        <p id="in-message">被指认的这条消息正文</p>
        <button id="msg-button">停止</button>
      </div>
      <div id="chat-blank"></div>
    </section>
    <button id="plain-button"><span>保存</span></button>
    <div id="naked-control" role="button"></div>
    <div id="file-tree-row" class="group flex"><span>notes.md</span></div>
  `;
});

describe('选区档', () => {
  it('有 window 选区压过消息：surround 带选区所在消息全文', () => {
    const r = resolve({
      target: document.querySelector('#in-message'),
      selectionText: ' 选中的片段 ',
      selectionAnchorEl: document.querySelector('#in-message'),
      findMessage: findInList,
    });
    expect(r).toEqual({
      type: 'selection',
      text: '选中的片段',
      surround: '被指认的这条消息正文',
      label: '“选中的片段”',
    });
  });

  it('选区锚点不在任何消息内：surround 缺省', () => {
    const r = resolve({
      target: document.querySelector('#plain-button'),
      selectionText: '别处选的字',
      selectionAnchorEl: document.querySelector('#plain-button'),
    });
    expect(r.type).toBe('selection');
    expect((r as { surround?: string }).surround).toBeUndefined();
  });

  it('window 选区为空时问编辑器选区（编辑器里选中、⌥点编辑器外）', () => {
    const r = resolve({
      target: document.querySelector('#chat-blank'),
      selectionText: '   ',
      getEditorSelection: () => '编辑器里选的段落',
    });
    expect(r).toEqual({
      type: 'selection',
      text: '编辑器里选的段落',
      label: '“编辑器里选的段落”',
    });
  });
});

describe('消息档', () => {
  it('点中消息：messageId / 原文 / 前后各 2 条可见上下文（隐藏旁白不占名额）', () => {
    const r = resolve({
      target: document.querySelector('#in-message'),
      findMessage: findInList,
    });
    expect(r.type).toBe('message');
    if (r.type !== 'message') return;
    expect(r.messageId).toBe('m4');
    expect(r.text).toBe('被指认的这条消息正文');
    expect(r.label).toBe('消息 · “被指认的这条消息正文”');
    // 前文 = 可见邻居取 2 条：m3 旁白 UI 不可见，既不泄进上下文也不占名额，窗口为 m1、m2
    expect(r.context).toContain('用户：前文一');
    expect(r.context).toContain('Oru：前文二');
    expect(r.context).not.toContain('系统记');
    // 后文窗口 = m5、m6（含流式半截——点击那一刻的快照）
    expect(r.context).toContain('用户：后文一');
    expect(r.context).toContain('Oru：流式半截');
    // 可见窗口外的不进
    expect(r.context).not.toContain('远古消息');
    expect(r.context).not.toContain('窗口外的后续');
  });

  it('消息压过控件：消息气泡里的按钮按消息档解析', () => {
    const r = resolve({
      target: document.querySelector('#msg-button'),
      findMessage: findInList,
    });
    expect(r.type).toBe('message');
  });

  it('DOM 有标识但 store 找不到：降档（宁可降档也不给没有原文的指认）', () => {
    const r = resolve({
      target: document.querySelector('#msg-button'),
      findMessage: () => null,
    });
    expect(r.type).toBe('control'); // msg-button 自己是 button，落控件档
  });
});

describe('控件档', () => {
  it('按钮（含嵌套文案）：caption 取可见文案', () => {
    const r = resolve({ target: document.querySelector('#plain-button span') });
    expect(r).toEqual({ type: 'control', caption: '保存', label: '控件 · 保存' });
  });

  it('role=button 无文案：caption 缺省、label 兜底', () => {
    const r = resolve({ target: document.querySelector('#naked-control') });
    expect(r).toEqual({ type: 'control', caption: undefined, label: '界面控件' });
  });

  it('caption 超长截断（a 套大块内容时不灌爆指代）', () => {
    const a = document.createElement('a');
    a.textContent = '长'.repeat(300);
    document.body.appendChild(a);
    const r = resolve({ target: a });
    expect(r.type).toBe('control');
    if (r.type !== 'control') return;
    expect(r.caption).toBe(`${'长'.repeat(120)}…`);
  });
});

describe('空白档', () => {
  it('对话区内空白：context 带最近几条可见消息', () => {
    const r = resolve({
      target: document.querySelector('#chat-blank'),
      getActiveMessages: () => LIST,
    });
    expect(r.type).toBe('blank');
    if (r.type !== 'blank') return;
    expect(r.label).toBe('对话区');
    expect(r.context).toContain('附近的对话：');
    expect(r.context).toContain('Oru：流式半截');
    expect(r.context).not.toContain('系统记');
  });

  it('文件树行（不注册 data-message-id）落 blank 档、无上下文', () => {
    const r = resolve({ target: document.querySelector('#file-tree-row span') });
    expect(r).toEqual({ type: 'blank', context: undefined, label: '界面空白处' });
  });

  it('target 为 null（极端事件形态）也有反应：blank', () => {
    expect(resolve({}).type).toBe('blank');
  });
});
