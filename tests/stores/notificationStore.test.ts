import { describe, expect, it } from 'vitest';
import { isDismissed } from '../../src/stores/notificationStore';

/**
 * 「忽略」水位判定的回归网——effectiveBadge 的「新动静复现」语义整个托付给这里的
 * 比较符（dismissedAt >= updatedAt 即隐藏），写反一个符号三处呈现一起说谎。
 */
describe('isDismissed — 忽略水位 vs 对话更新时刻', () => {
  it('水位晚于更新 → 隐藏', () => {
    expect(isDismissed({ c1: 200 }, 'c1', 100)).toBe(true);
  });

  it('水位等于更新 → 隐藏（忽略那一刻的动静本身被盖掉）', () => {
    expect(isDismissed({ c1: 100 }, 'c1', 100)).toBe(true);
  });

  it('新动静高过水位 → 复现', () => {
    expect(isDismissed({ c1: 100 }, 'c1', 200)).toBe(false);
  });

  it('从未忽略过 → 不隐藏', () => {
    expect(isDismissed({}, 'c1', 100)).toBe(false);
    expect(isDismissed({ other: 999 }, 'c1', 100)).toBe(false);
  });
});
