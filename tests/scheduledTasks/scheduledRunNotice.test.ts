/**
 * 定时任务后台执行完毕的下一回合旁白（S18·§7）——扫描历史尾部，最后一条「真回复」之后有
 * scheduled-run 结果卡就注入旁白；模型开口后（新真回复把卡隔在其前）下轮不再命中。
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@shared/types';
import { buildScheduledRunNotice } from '../../electron/main/agent/hooks';

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: Math.random().toString(36).slice(2),
  conversationId: 'c',
  role: 'user',
  text: '',
  toolCalls: [],
  createdAt: 0,
  done: true,
  ...over,
});

const card = (title: string, status: 'ok' | 'error' = 'ok') =>
  msg({ role: 'system', kind: 'scheduled-run', scheduledRun: { taskId: 't', title, status } });

describe('buildScheduledRunNotice', () => {
  it('末尾有结果卡（在最后真回复之后）→ 注入旁白、列出标题', () => {
    const h = [
      msg({ role: 'user', text: '你好' }),
      msg({ role: 'assistant', text: '嗨' }), // 上一条真回复
      card('每日简报'),
      msg({ role: 'assistant', kind: 'scheduled-run-output', text: '简报正文' }), // 执行体产出，不算真回复
    ];
    const notice = buildScheduledRunNotice(h);
    expect(notice).toContain('定时任务后台执行完毕');
    expect(notice).toContain('每日简报');
  });

  it('模型已开口（真回复在结果卡之后）→ 不再注入（下轮去重）', () => {
    const h = [
      msg({ role: 'assistant', text: '嗨' }),
      card('每日简报'),
      msg({ role: 'assistant', kind: 'scheduled-run-output', text: '简报正文' }),
      msg({ role: 'user', text: '收到' }),
      msg({ role: 'assistant', text: '好的，我看到了' }), // 新的真回复把卡隔在前面
    ];
    expect(buildScheduledRunNotice(h)).toBe('');
  });

  it('scheduled-run-output 不被当真回复（否则它会把该注入的旁白挡掉）', () => {
    // 只有执行体产出、没有真 assistant 回复：卡仍应命中
    const h = [
      msg({ role: 'user', text: '早' }),
      card('晨间提醒'),
      msg({ role: 'assistant', kind: 'scheduled-run-output', text: '提醒正文' }),
    ];
    expect(buildScheduledRunNotice(h)).toContain('晨间提醒');
  });

  it('失败卡带「执行失败」标注', () => {
    const h = [msg({ role: 'assistant', text: '嗨' }), card('数据同步', 'error')];
    const notice = buildScheduledRunNotice(h);
    expect(notice).toContain('数据同步');
    expect(notice).toContain('执行失败');
  });

  it('无结果卡 → 空串', () => {
    const h = [msg({ role: 'user', text: 'hi' }), msg({ role: 'assistant', text: 'yo' })];
    expect(buildScheduledRunNotice(h)).toBe('');
  });
});
