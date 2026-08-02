import { describe, it, expect } from 'vitest';
import { layoutTabs, TAB_FULL, TAB_MIN, OVERFLOW_BTN_WIDTH } from '@/components/workspace/tabLayout';

/** 一次布局是否撑破容器：可见标签总宽（等宽）+ 有溢出时的按钮宽 ≤ 容器宽。 */
function usedWidth(l: ReturnType<typeof layoutTabs>): number {
  return l.visible.length * l.width + (l.overflow.length ? OVERFLOW_BTN_WIDTH : 0);
}

describe('layoutTabs 标签宽度分配', () => {
  it('宽松：放得下就都是 180，不出溢出', () => {
    const l = layoutTabs(900, 3, 0);
    expect(l).toEqual({ visible: [0, 1, 2], overflow: [], width: TAB_FULL });
  });

  it('中间档：塞得下但不够 180，全可见并均分', () => {
    const l = layoutTabs(900, 6, 2);
    expect(l.overflow).toEqual([]);
    expect(l.visible).toHaveLength(6);
    expect(l.width).toBeGreaterThanOrEqual(TAB_MIN);
    expect(l.width).toBeLessThan(TAB_FULL);
    expect(usedWidth(l)).toBeLessThanOrEqual(900);
  });

  it('活跃标签不占额外宽度：换谁活跃，布局一个字节都不变', () => {
    expect(layoutTabs(900, 6, 0)).toEqual(layoutTabs(900, 6, 5));
    expect(layoutTabs(900, 20, 0).width).toBe(layoutTabs(900, 20, 3).width);
  });

  it('溢出档：压到下限仍放不下则多余进菜单，且不撑破容器', () => {
    const l = layoutTabs(900, 20, 0);
    expect(l.overflow.length).toBeGreaterThan(0);
    expect(l.visible.length + l.overflow.length).toBe(20);
    expect(l.width).toBeGreaterThanOrEqual(TAB_MIN);
    expect(usedWidth(l)).toBeLessThanOrEqual(900);
  });

  it('可见与溢出合起来正好是全集且各自有序、无重叠', () => {
    const l = layoutTabs(700, 15, 12);
    expect([...l.visible, ...l.overflow].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, i) => i),
    );
    expect(l.visible).toEqual([...l.visible].sort((a, b) => a - b));
    expect(l.overflow).toEqual([...l.overflow].sort((a, b) => a - b));
  });

  it('活跃标签落在溢出区时被提进可见区，可见个数不变', () => {
    const front = layoutTabs(900, 20, 0);
    const tail = layoutTabs(900, 20, 19);
    expect(tail.visible).toContain(19);
    expect(tail.visible).toHaveLength(front.visible.length);
    expect(usedWidth(tail)).toBeLessThanOrEqual(900);
  });

  it('极窄容器：只剩活跃标签可见，其余全进菜单', () => {
    const l = layoutTabs(120, 8, 3);
    expect(l.visible).toEqual([3]);
    expect(l.overflow).toHaveLength(7);
    expect(usedWidth(l)).toBeLessThanOrEqual(120);
  });

  it('可见区只剩一格时那一格也要退让（无活跃标签同样成立）', () => {
    const l = layoutTabs(150, 10, -1);
    expect(l.visible).toHaveLength(1);
    expect(l.width).toBeLessThanOrEqual(150 - OVERFLOW_BTN_WIDTH);
    expect(usedWidth(l)).toBeLessThanOrEqual(150);
  });

  it('只有一个标签时撑满可用宽，不预留溢出按钮', () => {
    expect(layoutTabs(120, 1, 0)).toEqual({ visible: [0], overflow: [], width: 120 });
    expect(layoutTabs(900, 1, 0).width).toBe(TAB_FULL);
  });

  it('无标签 / 无活跃标签 / 负宽度都不炸', () => {
    expect(layoutTabs(900, 0, -1).visible).toEqual([]);
    const noActive = layoutTabs(400, 10, -1);
    expect(noActive.visible.every((i) => i >= 0)).toBe(true);
    expect(usedWidth(noActive)).toBeLessThanOrEqual(400);
    expect(() => layoutTabs(-50, 5, 0)).not.toThrow();
  });
});
