/**
 * tableStats —— 统计条与视图态纯函数：宽松数字解析（剥千分位/货币符/百分号）、
 * 筛选后可见行统计、排序间接下标（rows 永远保持文件序）。
 */
import { describe, expect, it } from 'vitest';
import { computeStats, displayIndexes, parseNum } from '@/lib/tableStats';

describe('parseNum', () => {
  it('白领金额常态：千分位逗号、货币符、百分号剥掉后解析', () => {
    expect(parseNum('¥1,234.56')).toBe(1234.56);
    expect(parseNum('$2,000')).toBe(2000);
    expect(parseNum('15%')).toBe(0.15);
    expect(parseNum('-3.5')).toBe(-3.5);
    expect(parseNum('１２３')).toBeNull(); // 全角不解析——宽松有边界
  });

  it('空值与文本返回 null', () => {
    expect(parseNum('')).toBeNull();
    expect(parseNum('  ')).toBeNull();
    expect(parseNum('张三')).toBeNull();
    expect(parseNum('1,2,3')).toBeNull(); // 千分位位置不合法不硬解析
  });
});

describe('computeStats', () => {
  it('数字列：计数/求和/平均；空值跳过；混入文本标注忽略数', () => {
    const s = computeStats(['¥1,000', '', '2,000', '备注', '3000']);
    expect(s).toEqual({ count: 4, sum: 6000, avg: 2000, ignored: 1 });
  });

  it('纯文本列：只有计数', () => {
    const s = computeStats(['张三', '李四', '']);
    expect(s).toEqual({ count: 2, sum: null, avg: null, ignored: 2 });
  });
});

describe('displayIndexes', () => {
  const rows = [
    ['华东', '300'],
    ['华北', '100'],
    ['华东', '200'],
  ];

  it('无排序无筛选：文件序', () => {
    expect(displayIndexes(rows, null, new Map())).toEqual([0, 1, 2]);
  });

  it('排序是间接下标，rows 不动；数值按数排，文本按 locale', () => {
    expect(displayIndexes(rows, { col: 1, asc: true }, new Map())).toEqual([1, 2, 0]);
    expect(displayIndexes(rows, { col: 1, asc: false }, new Map())).toEqual([0, 2, 1]);
  });

  it('筛选按值勾选、列下标为 key；筛选与排序叠加', () => {
    const filters = new Map([[0, new Set(['华东'])]]);
    expect(displayIndexes(rows, null, filters)).toEqual([0, 2]);
    expect(displayIndexes(rows, { col: 1, asc: true }, filters)).toEqual([2, 0]);
  });

  it('多列筛选叠加生效', () => {
    const filters = new Map([
      [0, new Set(['华东'])],
      [1, new Set(['200'])],
    ]);
    expect(displayIndexes(rows, null, filters)).toEqual([2]);
  });

  it('排序稳定：同值保持文件序', () => {
    expect(displayIndexes(rows, { col: 0, asc: true }, new Map())).toEqual([1, 0, 2]);
  });
});
