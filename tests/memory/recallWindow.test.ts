/**
 * projectConversationWindow 单测 —— 喂给召回挑选器的「当前对话窗口」投影
 *
 * 只留真人 ↔ 助手的自然语言（§1.3）：剥 tool_result（不在 text 里，天然排除）、
 * 剥一切卡片/脚手架（kind !== undefined）、剥 system；最新一条 user 是主查询信号、落在窗口末尾；
 * 窗口按预算截断、总保留最后一条。设计见 recall tech-design §1.3。
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatMessageKind, ChatRole } from '@shared/types';
import { projectConversationWindow } from '../../electron/main/memory/recall/window';

let seq = 0;
function msg(role: ChatRole, text: string, kind?: ChatMessageKind): ChatMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    conversationId: 'c1',
    role,
    text,
    toolCalls: [],
    createdAt: seq,
    done: true,
    kind,
  };
}

describe('projectConversationWindow', () => {
  it('保留真人↔助手自然语言，剥 system 与空文本', () => {
    const win = projectConversationWindow([
      msg('system', '你是…'),
      msg('user', '帮我看看搬家方案'),
      msg('assistant', '好，我看下你之前记的换房计划'),
      msg('assistant', ''), // 空文本（流式占位）不进
    ]);
    expect(win).toEqual([
      { role: 'user', text: '帮我看看搬家方案' },
      { role: 'assistant', text: '好，我看下你之前记的换房计划' },
    ]);
  });

  it('剥一切卡片/脚手架（kind !== undefined）——含上轮注入相关的卡片', () => {
    const win = projectConversationWindow([
      msg('user', '真问题一句'),
      msg('assistant', '已记下 X', 'memory-record'),
      msg('user', '系统记…', 'turn-terminator'),
      msg('assistant', '一个提案', 'proposal'),
      msg('assistant', '正常回复'),
    ]);
    expect(win).toEqual([
      { role: 'user', text: '真问题一句' },
      { role: 'assistant', text: '正常回复' },
    ]);
  });

  it('最新一条 user 是主查询信号，落在窗口末尾', () => {
    const win = projectConversationWindow([
      msg('user', '早先的话'),
      msg('assistant', '回应'),
      msg('user', '最新这句才是主查询'),
    ]);
    expect(win[win.length - 1]).toEqual({ role: 'user', text: '最新这句才是主查询' });
  });

  it('按预算截断，保留最近的几轮，且总保留最后一条', () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 50; i += 1) {
      history.push(msg('user', `第 ${i} 句`.repeat(20)));
    }
    const win = projectConversationWindow(history, { maxChars: 500 });
    // 截断后远少于 50 条
    expect(win.length).toBeLessThan(50);
    expect(win.length).toBeGreaterThan(0);
    // 最后一条一定在（最新 user = 主查询信号绝不丢）
    expect(win[win.length - 1].text).toBe(`第 49 句`.repeat(20));
  });

  it('tool_result/工具调用不进窗口（text 不含工具输出；toolCalls 被忽略）', () => {
    const m = msg('assistant', '我读了文件，结论是 X');
    m.toolCalls = [
      { id: 't1', name: 'read_file', input: { path: '/big' }, result: '几千 token 文件内容…' } as never,
    ];
    const win = projectConversationWindow([msg('user', '看下那个文件'), m]);
    expect(win).toEqual([
      { role: 'user', text: '看下那个文件' },
      { role: 'assistant', text: '我读了文件，结论是 X' },
    ]);
    expect(JSON.stringify(win)).not.toContain('几千 token');
  });
});
