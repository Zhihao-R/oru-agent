/**
 * computeNewOrder 单元测试——slide 重排的纯函数
 * 约定 newOrder[newPos] = oldPageIndex；拖回原位返回 null。
 */
import { describe, expect, it } from 'vitest';
import { computeNewOrder } from '../../src/lib/reorderSlides';

describe('computeNewOrder', () => {
  it('把第 0 页拖到第 2 页之后', () => {
    // [0,1,2,3] 把 0 移到 2 后面 → [1,2,0,3]
    expect(computeNewOrder(4, 0, 2, 'after')).toEqual([1, 2, 0, 3]);
  });

  it('把第 3 页拖到第 1 页之前', () => {
    // [0,1,2,3] 把 3 移到 1 前面 → [0,3,1,2]
    expect(computeNewOrder(4, 3, 1, 'before')).toEqual([0, 3, 1, 2]);
  });

  it('相邻前移：第 2 页拖到第 1 页之前', () => {
    expect(computeNewOrder(4, 2, 1, 'before')).toEqual([0, 2, 1, 3]);
  });

  it('拖回原位（before 自身）返回 null', () => {
    expect(computeNewOrder(4, 1, 1, 'before')).toBeNull();
  });

  it('拖到相邻格子但落点等同原位返回 null', () => {
    // 把 1 移到 0 之后 = 不动
    expect(computeNewOrder(4, 1, 0, 'after')).toBeNull();
    // 把 1 移到 2 之前 = 不动
    expect(computeNewOrder(4, 1, 2, 'before')).toBeNull();
  });

  it('首尾互换边界：第 0 页拖到末页之后', () => {
    expect(computeNewOrder(3, 0, 2, 'after')).toEqual([1, 2, 0]);
  });
});
