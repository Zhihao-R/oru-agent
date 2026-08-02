/**
 * 断线自动接续预算（S25 G23/G03）单元测试。
 * peek 预看（不消费）+ claim 消费分离（decide-then-run，M2）：peek 到上限即 null；重置后重获满额；
 * 对话之间互不干扰。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  peekAutoContinue,
  claimAutoContinue,
  resetAutoContinue,
  MAX_AUTO_CONTINUE,
} from '../../electron/main/agent/autoContinue';

describe('autoContinue 预算', () => {
  beforeEach(() => {
    resetAutoContinue('c1');
    resetAutoContinue('c2');
  });

  it('peek 报下一次序号（不消费），claim 消费；到 MAX 后 peek 为 null', () => {
    const seen: Array<number | null> = [];
    for (let i = 0; i < MAX_AUTO_CONTINUE + 2; i++) {
      seen.push(peekAutoContinue('c1')); // 预看
      claimAutoContinue('c1'); // 消费
    }
    const expected = Array.from({ length: MAX_AUTO_CONTINUE }, (_, i) => i + 1);
    expect(seen.slice(0, MAX_AUTO_CONTINUE)).toEqual(expected);
    expect(seen.slice(MAX_AUTO_CONTINUE)).toEqual([null, null]);
  });

  it('peek 不消费：连续 peek 同一值', () => {
    expect(peekAutoContinue('c1')).toBe(1);
    expect(peekAutoContinue('c1')).toBe(1); // 没 claim → 不动
    claimAutoContinue('c1');
    expect(peekAutoContinue('c1')).toBe(2);
  });

  it('reset 后重获满额', () => {
    for (let i = 0; i < MAX_AUTO_CONTINUE; i++) claimAutoContinue('c1');
    expect(peekAutoContinue('c1')).toBeNull();
    resetAutoContinue('c1');
    expect(peekAutoContinue('c1')).toBe(1);
  });

  it('不同对话预算独立', () => {
    for (let i = 0; i < MAX_AUTO_CONTINUE; i++) claimAutoContinue('c1');
    expect(peekAutoContinue('c1')).toBeNull();
    expect(peekAutoContinue('c2')).toBe(1); // c2 不受 c1 影响
  });
});
