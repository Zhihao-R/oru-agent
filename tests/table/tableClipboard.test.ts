/**
 * 表格剪贴板 —— 选区 ⇄ TSV 的坐标映射。
 *
 * 承重不变量：
 *   - 复制读**显示序**：排序后复制出去的顺序 = 屏幕上看到的顺序，不是文件里的顺序。
 *   - 粘贴落点是选区**左上角**，不是拖拽锚点——反向框选时两者不等。
 *   - 溢出可见行时在文件末尾追加新行（不截断、不丢数据），并如实报出追加了几行。
 *   - 单值铺满：源只有一格且选区大于一格时按选区尺寸铺开。
 */
import { describe, expect, it } from 'vitest';
import { selectionToTsv, tsvToBlock } from '@/components/table/tableClipboard';
import type { TableSelection } from '@/lib/tableSelection';

const ROWS = [
  ['a1', 'b1'],
  ['a2', 'b2'],
  ['a3', 'b3'],
];
const ALL = [0, 1, 2];

describe('selectionToTsv', () => {
  it('矩形选区按制表符/换行导出', () => {
    expect(selectionToTsv(ROWS, ALL, { kind: 'range', r1: 0, c1: 0, r2: 1, c2: 1 })).toBe('a1\tb1\na2\tb2');
  });

  it('排序态导出的是屏幕顺序，不是文件顺序', () => {
    // 显示序 [2,0,1]：屏幕第一行是文件第 3 行
    expect(selectionToTsv(ROWS, [2, 0, 1], { kind: 'range', r1: 0, c1: 0, r2: 1, c2: 0 })).toBe('a3\na1');
  });

  it('反向框选（右下→左上）与正向导出一致', () => {
    const forward = selectionToTsv(ROWS, ALL, { kind: 'range', r1: 0, c1: 0, r2: 1, c2: 1 });
    const backward = selectionToTsv(ROWS, ALL, { kind: 'range', r1: 1, c1: 1, r2: 0, c2: 0 });
    expect(backward).toBe(forward);
  });

  it('整列选区导出当前可见的那些行', () => {
    expect(selectionToTsv(ROWS, [0, 2], { kind: 'col', col: 1 })).toBe('b1\nb3');
  });

  it('含换行的单元格裹引号——粘回来能还原', () => {
    const multi = [['第一行\n第二行', 'x']];
    expect(selectionToTsv(multi, [0], { kind: 'range', r1: 0, c1: 0, r2: 0, c2: 0 })).toBe('"第一行\n第二行"');
  });

  it('无选区 → 空串', () => {
    expect(selectionToTsv(ROWS, ALL, null)).toBe('');
  });
});

describe('tsvToBlock', () => {
  const at = (r: number, c: number) => ({ r, c });
  const one = { rows: 1, cols: 1 };

  it('落在选区左上角，不扩表时 rows 就是对应的文件行号', () => {
    const out = tsvToBlock('x\ty\nz\tw', ALL, 3, at(1, 0), one);
    expect(out).toEqual({
      rows: [1, 2],
      col: 0,
      block: [
        ['x', 'y'],
        ['z', 'w'],
      ],
      appended: 0,
    });
  });

  it('筛选态：落点与后续行都按显示序取文件行号', () => {
    // 只显示文件第 0、2 行
    const out = tsvToBlock('p\nq', [0, 2], 3, at(0, 0), one);
    expect(out?.rows).toEqual([0, 2]);
  });

  it('溢出可见行 → 在文件末尾追加新行，并报出追加了几行', () => {
    const out = tsvToBlock('p\nq\nr', [0, 2], 3, at(1, 0), one); // 从显示序 1（文件 2）起要 3 行
    expect(out?.rows).toEqual([2, 3, 4]); // 文件行 2，然后追加 3、4
    expect(out?.appended).toBe(2);
  });

  it('单值铺满选区', () => {
    const out = tsvToBlock('已完成', ALL, 3, at(0, 0), { rows: 3, cols: 2 });
    expect(out?.block).toEqual([
      ['已完成', '已完成'],
      ['已完成', '已完成'],
      ['已完成', '已完成'],
    ]);
    expect(out?.rows).toEqual([0, 1, 2]);
  });

  it('单值粘到单格不铺满（选区就一格）', () => {
    const out = tsvToBlock('已完成', ALL, 3, at(0, 0), one);
    expect(out?.block).toEqual([['已完成']]);
  });

  it('多格源不受选区尺寸影响，按源尺寸铺开', () => {
    const out = tsvToBlock('x\ty', ALL, 3, at(0, 0), { rows: 3, cols: 3 });
    expect(out?.block).toEqual([['x', 'y']]);
  });

  it('参差不齐的 TSV 补齐到最宽——否则写入会按首行宽度越界', () => {
    const out = tsvToBlock('a\tb\tc\nd', ALL, 3, at(0, 0), one);
    expect(out?.block).toEqual([
      ['a', 'b', 'c'],
      ['d', '', ''],
    ]);
  });

  it('Excel 尾随 CRLF 不产生多余空行', () => {
    const out = tsvToBlock('x\ty\r\n', ALL, 3, at(0, 0), one);
    expect(out?.block).toEqual([['x', 'y']]);
    expect(out?.rows).toEqual([0]);
  });

  it('空剪贴板 → null（不产生空 op）', () => {
    expect(tsvToBlock('', ALL, 3, at(0, 0), one)).toBeNull();
  });
});
