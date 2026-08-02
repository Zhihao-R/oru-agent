/**
 * handbackForm（S08 · G14）——交还分流单源：前端交还与崩溃恢复共用一个判定。
 * 'draft'：桌面用户亲手打的字（trigger==='user' 且无 origin）→ 回填输入框。
 * 'pending-item'：定时触发（scheduled）、渠道消息（带 origin）→ 列成待处理项。
 * 'drop'：后台任务完成（task-completed）→ 静默丢弃（可再生，不交还，见 S09 review · M2）。
 */
import { describe, expect, it } from 'vitest';
import { handbackForm } from '../../shared/agent/handback';

describe('handbackForm · 交还分流单源', () => {
  it('桌面用户亲手打的字（user 无 origin）→ draft', () => {
    expect(handbackForm({ trigger: 'user' })).toBe('draft');
  });

  it('定时任务触发（scheduled）→ pending-item', () => {
    expect(handbackForm({ trigger: 'scheduled' })).toBe('pending-item');
  });

  it('后台任务完成（task-completed）→ drop（可再生，不交还给用户）', () => {
    expect(handbackForm({ trigger: 'task-completed' })).toBe('drop');
  });

  it('渠道消息（user 但带 origin）→ pending-item（不塞回桌面输入框）', () => {
    expect(
      handbackForm({
        trigger: 'user',
        origin: { platform: 'feishu', chatId: 'c', platformMessageId: 'm' },
      }),
    ).toBe('pending-item');
  });
});
