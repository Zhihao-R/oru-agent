/**
 * 表格查找与全量替换。
 *
 * 承重不变量：
 *   - 命中**按屏幕顺序产出、坐标存文件行号**：显示序会因「只看命中行」二次过滤而变，
 *     存显示序会让坐标与过滤后的视图错位，而过滤又依赖命中集合，两者互相咬住。
 *   - 被筛掉的行不参与匹配（找不到本就看不见的东西）。
 *   - 表头参与匹配但不参与替换（block op 不写表头）。
 *   - 替换一次成型：`a → aa` 不能边替边重扫，否则无限展开。
 *   - 命中离散、block 是矩形：行方向精确只收命中行，列方向取包围盒。
 */
import { describe, expect, it } from 'vitest';
import { findHits, hitFileRows, replaceAllTarget, HEADER_ROW } from '@/components/table/tableSearch';

const HEADERS = ['名称', '状态'];
const ROWS = [
  ['张三', '进行中'],
  ['李四', '已完成'],
  ['王五', '进行中'],
];
const ALL = [0, 1, 2];

describe('findHits', () => {
  it('按屏幕顺序、从左到右给出命中', () => {
    expect(findHits(HEADERS, ROWS, ALL, '进行中')).toEqual([
      { fileRow: 0, col: 1 },
      { fileRow: 2, col: 1 },
    ]);
  });

  it('表头参与匹配，标记为表头行', () => {
    expect(findHits(HEADERS, ROWS, ALL, '状态')).toEqual([{ fileRow: HEADER_ROW, col: 1 }]);
  });

  it('大小写不敏感——query 用大写，漏做 query.toLowerCase() 的实现会露馅', () => {
    expect(findHits(['Name'], [['ALICE'], ['bob']], [0, 1], 'A')).toEqual([
      { fileRow: HEADER_ROW, col: 0 },
      { fileRow: 0, col: 0 },
    ]);
  });

  it('筛选态下被筛掉的行不参与匹配', () => {
    expect(findHits(HEADERS, ROWS, [0], '进行中')).toEqual([{ fileRow: 0, col: 1 }]);
  });

  it('排序态：坐标是文件行号，顺序是屏幕顺序', () => {
    // 显示序 [2,1,0]：文件第 3 行排到屏幕第一行，命中坐标仍写文件行号 2
    expect(findHits(HEADERS, ROWS, [2, 1, 0], '王五')).toEqual([{ fileRow: 2, col: 0 }]);
    // 两个「进行中」分别在文件行 0 和 2；屏幕上文件行 2 在前，所以它先出
    expect(findHits(HEADERS, ROWS, [2, 1, 0], '进行中')).toEqual([
      { fileRow: 2, col: 1 },
      { fileRow: 0, col: 1 },
    ]);
  });

  it('数据行字段多于表头时，越界的那些格子不参与匹配（渲染也画不出它们）', () => {
    // 参差 CSV 合法：这一行有 3 个字段，但表只有 2 列
    expect(findHits(['甲', '乙'], [['x', 'y', 'x']], [0], 'x')).toEqual([{ fileRow: 0, col: 0 }]);
  });

  it('空查询无命中', () => {
    expect(findHits(HEADERS, ROWS, ALL, '')).toEqual([]);
  });
});

describe('hitFileRows（只看命中行）', () => {
  it('去重、保持屏幕顺序，且不含表头', () => {
    const hits = [
      { fileRow: HEADER_ROW, col: 0 },
      { fileRow: 2, col: 1 },
      { fileRow: 0, col: 0 },
      { fileRow: 2, col: 0 },
    ];
    expect(hitFileRows(hits)).toEqual([2, 0]); // 屏幕顺序，不是升序
  });
});

describe('replaceAllTarget', () => {
  it('只收命中行，列取包围盒，未命中的格子保持原值', () => {
    const out = replaceAllTarget(findHits(HEADERS, ROWS, ALL, '进行中'), ROWS, '进行中', '处理中');
    expect(out).toEqual({
      rows: [0, 2], // 文件第 2 行没命中，不进来
      col: 1,
      block: [['处理中'], ['处理中']],
    });
  });

  it('命中跨列时包围盒把中间列一起带上，但内容不变', () => {
    const rows = [['x', '中间', 'x']];
    const out = replaceAllTarget(findHits(['甲', '乙', '丙'], rows, [0], 'x'), rows, 'x', 'y');
    expect(out?.col).toBe(0);
    expect(out?.block).toEqual([['y', '中间', 'y']]);
  });

  it('a → aa 一次成型，不无限展开', () => {
    const rows = [['aaa']];
    const out = replaceAllTarget(findHits(['列'], rows, [0], 'a'), rows, 'a', 'aa');
    expect(out?.block).toEqual([['aaaaaa']]); // 3 个 a 各变 2 个，不是无限
  });

  it('正则特殊字符按字面匹配——abc 不被 a.c 当通配命中', () => {
    const rows = [['a.c', 'abc', 'a.c']];
    const hits = findHits(['甲', '乙', '丙'], rows, [0], 'a.c');
    expect(hits).toEqual([
      { fileRow: 0, col: 0 },
      { fileRow: 0, col: 2 },
    ]); // 中间的 abc 没命中
    // 它落在包围盒里但原值不动，正好一并验证「未命中的格子原样写回」
    expect(replaceAllTarget(hits, rows, 'a.c', 'X')?.block).toEqual([['X', 'abc', 'X']]);
  });

  it('替换串里的 $ 是字面量，不是替换模式', () => {
    const rows = [['价格']];
    const out = replaceAllTarget(findHits(['列'], rows, [0], '价格'), rows, '价格', '$&元');
    expect(out?.block).toEqual([['$&元']]);
  });

  it('大小写不敏感地替换，命中处按替换串写入', () => {
    const rows = [['Hello hello']];
    const out = replaceAllTarget(findHits(['列'], rows, [0], 'hello'), rows, 'hello', '你好');
    expect(out?.block).toEqual([['你好 你好']]);
  });

  it('表头命中不参与替换', () => {
    expect(replaceAllTarget(findHits(HEADERS, ROWS, ALL, '状态'), ROWS, '状态', 'X')).toBeNull();
  });

  it('筛选态下替换的是可见命中行对应的文件行', () => {
    const idx = [2]; // 只显示文件第 3 行
    const out = replaceAllTarget(findHits(HEADERS, ROWS, idx, '进行中'), ROWS, '进行中', '处理中');
    expect(out?.rows).toEqual([2]);
  });

  it('无命中 / 空查询 → null', () => {
    expect(replaceAllTarget([], ROWS, 'x', 'y')).toBeNull();
    expect(replaceAllTarget(findHits(HEADERS, ROWS, ALL, '进行中'), ROWS, '', 'y')).toBeNull();
  });
});
