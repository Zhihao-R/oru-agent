/**
 * 表格选区几何 —— 锚点/焦点语义下的归一化、命中判定、区域统计。
 *
 * 承重不变量：选区存的是**锚点 + 焦点**（r1c1 = 拖拽起点，r2c2 = 当前端点）而非规范化矩形，
 * 因为 Shift+方向扩选必须知道从哪一端扩——规范化会把方向信息抹掉。代价是所有消费者
 * 都得先归一化，故收敛到 normalizeRange 一处：反向框选（右下拖到左上）与正向必须等价。
 */
import { describe, expect, it } from 'vitest';
import { computeStatsForSelection, isCellSelected, normalizeRange } from '@/lib/tableSelection';

const ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
];
const IDX = [0, 1, 2]; // 无排序无筛选：显示序 = 文件序

describe('normalizeRange', () => {
  it('正向框选原样返回', () => {
    expect(normalizeRange({ r1: 0, c1: 0, r2: 2, c2: 1 })).toEqual({ r1: 0, c1: 0, r2: 2, c2: 1 });
  });

  it('反向框选（右下→左上）归一为同一区间', () => {
    expect(normalizeRange({ r1: 2, c1: 1, r2: 0, c2: 0 })).toEqual({ r1: 0, c1: 0, r2: 2, c2: 1 });
  });

  it('单向反转（只有行反或只有列反）各自独立归一', () => {
    expect(normalizeRange({ r1: 2, c1: 0, r2: 0, c2: 1 })).toEqual({ r1: 0, c1: 0, r2: 2, c2: 1 });
    expect(normalizeRange({ r1: 0, c1: 1, r2: 2, c2: 0 })).toEqual({ r1: 0, c1: 0, r2: 2, c2: 1 });
  });

  it('单格（锚点=焦点）归一为自身', () => {
    expect(normalizeRange({ r1: 1, c1: 1, r2: 1, c2: 1 })).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 });
  });
});

describe('isCellSelected', () => {
  const forward = { kind: 'range', r1: 0, c1: 0, r2: 1, c2: 1 } as const;
  const backward = { kind: 'range', r1: 1, c1: 1, r2: 0, c2: 0 } as const;

  it('反向框选与正向命中完全一致', () => {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(isCellSelected(backward, r, c)).toBe(isCellSelected(forward, r, c));
      }
    }
  });

  it('区间内命中、区间外不命中', () => {
    expect(isCellSelected(forward, 0, 0)).toBe(true);
    expect(isCellSelected(forward, 1, 1)).toBe(true);
    expect(isCellSelected(forward, 2, 0)).toBe(false);
    expect(isCellSelected(forward, 0, 2)).toBe(false);
  });

  it('列选区只看列、不看行', () => {
    expect(isCellSelected({ kind: 'col', col: 1 }, 0, 1)).toBe(true);
    expect(isCellSelected({ kind: 'col', col: 1 }, 99, 1)).toBe(true);
    expect(isCellSelected({ kind: 'col', col: 1 }, 0, 0)).toBe(false);
  });

  it('无选区恒不命中', () => {
    expect(isCellSelected(null, 0, 0)).toBe(false);
  });
});

describe('computeStatsForSelection', () => {
  it('反向框选的统计与正向逐字段一致', () => {
    const forward = computeStatsForSelection(ROWS, IDX, { kind: 'range', r1: 0, c1: 0, r2: 1, c2: 1 });
    const backward = computeStatsForSelection(ROWS, IDX, { kind: 'range', r1: 1, c1: 1, r2: 0, c2: 0 });
    expect(backward).toEqual(forward);
    expect(forward?.count).toBe(4); // 1,2,4,5
  });

  it('筛选态下按显示序取行——统计的是屏幕上那几行', () => {
    const stats = computeStatsForSelection(ROWS, [2, 0], { kind: 'range', r1: 0, c1: 0, r2: 1, c2: 0 });
    expect(stats?.sum).toBe(8); // 显示序 0→文件行 2（'7'）、显示序 1→文件行 0（'1'）
  });

  it('列统计对筛选后的可见行算', () => {
    expect(computeStatsForSelection(ROWS, [0, 1], { kind: 'col', col: 0 })?.sum).toBe(5); // 1+4，第三行被筛掉
  });

  it('无选区 → null', () => {
    expect(computeStatsForSelection(ROWS, IDX, null)).toBeNull();
  });
});
