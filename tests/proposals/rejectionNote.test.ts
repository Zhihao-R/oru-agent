/**
 * 拒绝附言（G02）——formatRejectionNote 带/不带 note 的措辞验证。
 */
import { describe, it, expect } from 'vitest';
import { formatRejectionNote } from '../../electron/main/proposals/systemEvent';
import { SYSTEM_NOTE_PREFIX } from '@shared/userTurn';

describe('formatRejectionNote', () => {
  it('无附言：基础模板（系统记前缀 + 别重复 propose）', () => {
    const s = formatRejectionNote('p1');
    expect(s.startsWith(SYSTEM_NOTE_PREFIX)).toBe(true);
    expect(s).toContain('p1');
    expect(s).toContain('不要在下一轮重复 propose');
    expect(s).not.toContain('用户附言');
  });

  it('有附言：随附「用户附言：<note>」', () => {
    const s = formatRejectionNote('p1', '这个目录不能动，换个位置');
    expect(s).toContain('用户附言：这个目录不能动，换个位置');
  });

  it('空白附言按无附言处理（trim 后为空）', () => {
    expect(formatRejectionNote('p1', '   ')).toBe(formatRejectionNote('p1'));
  });
});
