import { describe, it, expect } from 'vitest';
import { fmtDuration } from '@/lib/fmtDuration';

describe('fmtDuration — 统一秒输出，无 ms / m / 复合单位', () => {
  it('null / undefined 返回 — 占位', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(undefined)).toBe('—');
  });

  it('< 1s：两位小数', () => {
    expect(fmtDuration(16)).toBe('0.02s');
    expect(fmtDuration(353)).toBe('0.35s');
    expect(fmtDuration(999)).toBe('1.00s'); // 边界向上 round 到 1.00s 可接受
  });

  it('1s ~ 10s：两位小数', () => {
    expect(fmtDuration(1000)).toBe('1.00s');
    expect(fmtDuration(9010)).toBe('9.01s');
  });

  it('10s ~ 100s：一位小数', () => {
    expect(fmtDuration(10_000)).toBe('10.0s');
    expect(fmtDuration(78_090)).toBe('78.1s');
    expect(fmtDuration(99_499)).toBe('99.5s');
  });

  it('≥ 100s：整数秒，无 m/s 复合', () => {
    expect(fmtDuration(100_000)).toBe('100s');
    expect(fmtDuration(124_730)).toBe('125s');
    // 关键反测：1m18s 这种复合不出现
    expect(fmtDuration(78_090)).not.toContain('m');
    expect(fmtDuration(124_730)).not.toContain('m');
  });

  it('负值兜底为 0s', () => {
    expect(fmtDuration(-10)).toBe('0s');
  });
});
