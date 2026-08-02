import { describe, it, expect } from 'vitest';
import { relativeTo } from '@/lib/paths';

describe('relativeTo', () => {
  it('去掉 base 前缀得项目相对路径', () => {
    expect(relativeTo('/Users/a/Proj', '/Users/a/Proj/deck-1')).toBe('deck-1');
    expect(relativeTo('/Users/a/Proj', '/Users/a/Proj/sub/deck-1')).toBe('sub/deck-1');
  });
  it('base 带尾斜杠也成立', () => {
    expect(relativeTo('/Users/a/Proj/', '/Users/a/Proj/deck-1')).toBe('deck-1');
  });
  it('abs 等于 base 回空串', () => {
    expect(relativeTo('/Users/a/Proj', '/Users/a/Proj')).toBe('');
  });
});
