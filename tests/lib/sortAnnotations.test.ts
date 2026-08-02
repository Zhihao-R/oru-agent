import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../shared/types';
import { sortAnnotations } from '../../src/lib/sortAnnotations';

/**
 * 标注排序测试
 *
 * 按 createdAt 升序——新标注追加到末尾、序号随添加递增；同毫秒落多条按原序稳定；不可变。
 */
function ann(id: string, createdAt: number): Annotation {
  return {
    id,
    comment: `c-${id}`,
    cropPath: '',
    htmlSnippet: '',
    text: '',
    locator: { scrollY: 0, rect: { x: 0, y: 0, w: 10, h: 10 } },
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
  };
}

describe('sortAnnotations', () => {
  it('按 createdAt 升序——新标注排末尾', () => {
    const a = ann('a', 30);
    const b = ann('b', 10);
    const c = ann('c', 20);
    const out = sortAnnotations([a, b, c]);
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('createdAt 相同：按原数组顺序稳定', () => {
    const a = ann('a', 5);
    const b = ann('b', 5);
    const c = ann('c', 5);
    const out = sortAnnotations([a, b, c]);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('不可变：不就地改入参', () => {
    const input = [ann('a', 20), ann('b', 10)];
    const out = sortAnnotations(input);
    expect(out.map((x) => x.id)).toEqual(['b', 'a']);
    expect(input.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
