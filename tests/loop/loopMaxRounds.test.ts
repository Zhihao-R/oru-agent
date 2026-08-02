import { describe, it, expect } from 'vitest';
import { clampLoopMaxRounds } from '../../electron/main/projects/store';

// S21·G120：轮数上限从写死常量改为设置项，用户可调；load 时 clamp 到 [1,20]、非法回落 5。
describe('clampLoopMaxRounds', () => {
  it('缺省 / 非数字 → 回落 5', () => {
    expect(clampLoopMaxRounds(undefined)).toBe(5);
    expect(clampLoopMaxRounds(NaN)).toBe(5);
    expect(clampLoopMaxRounds(Infinity)).toBe(5);
  });

  it('越界钳到 [1,20]', () => {
    expect(clampLoopMaxRounds(0)).toBe(1);
    expect(clampLoopMaxRounds(-3)).toBe(1);
    expect(clampLoopMaxRounds(999)).toBe(20);
  });

  it('小数取整，范围内原样', () => {
    expect(clampLoopMaxRounds(3)).toBe(3);
    expect(clampLoopMaxRounds(7.6)).toBe(8);
  });
});
