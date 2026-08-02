/**
 * 联系表纯函数单测：拆头体 / standalone 组装（归一化注入）/ 网格布局 / 大 deck 分批。
 * 渲染与 canvas 合成（需 Electron）由 __smoke_deck_contact_sheet__ 覆盖，不在此。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  extractHeadAndBody,
  assembleStandalonePage,
  slideRenderCss,
  planContactSheets,
  selectSheetBatch,
  gridCell,
  GRID,
  MAX_SHEETS_PER_CALL,
  mapWithConcurrency,
} from '../../electron/main/deck/contactSheet';

const SLIDES_PER_SHEET = GRID.cols * GRID.rows;

describe('extractHeadAndBody', () => {
  it('取 head 内容 + body 开标签（保留 body 属性）', () => {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><style>.slide{}</style></head>' +
      '<body class="deck" data-theme="x"><section class="slide">P1</section></body></html>';
    const { head, bodyOpenTag } = extractHeadAndBody(html);
    expect(head).toContain('<meta charset="utf-8">');
    expect(head).toContain('.slide{}');
    expect(bodyOpenTag).toBe('<body class="deck" data-theme="x">');
  });

  it('无 head / 无 body 时给安全默认', () => {
    const { head, bodyOpenTag } = extractHeadAndBody('<section class="slide">only</section>');
    expect(head).toBe('');
    expect(bodyOpenTag).toBe('<body>');
  });
});

describe('assembleStandalonePage + slideRenderCss', () => {
  it('归一化样式后置在 head 末尾、按激活页渲染（flex 居中 + 定尺画布 + 强制可见）', () => {
    const css = slideRenderCss({ width: 1920, height: 1080 });
    const out = assembleStandalonePage('<title>t</title>', '<body class="deck">', '<section class="slide">P</section>', css);
    // 归一化样式必须在原 head 之后（压过 deck 自身规则）
    expect(out.indexOf('<title>t</title>')).toBeLessThan(out.indexOf('display:flex!important'));
    expect(out).toContain('opacity:1!important');
    // flex（非 block）：保住 deck flex 居中；relative（非 static）：保住绝对定位包含块
    expect(out).toContain('display:flex!important');
    expect(out).toContain('position:relative!important');
    expect(out).toContain('transform:none!important');
    // 定尺到画布——源文件 .slide 无尺寸，不补则稀疏页居中失效
    expect(out).toContain('width:1920px!important');
    expect(out).toContain('height:1080px!important');
    // 保留 body 开标签 + 只放这一页
    expect(out).toContain('<body class="deck">');
    expect(out).toContain('<section class="slide">P</section>');
  });

  it('slideRenderCss 定尺随画布（竖版不压扁）', () => {
    const css = slideRenderCss({ width: 1080, height: 1920 });
    expect(css).toContain('width:1080px!important');
    expect(css).toContain('height:1920px!important');
  });
});

describe('planContactSheets', () => {
  it('9 页 → 1 张网格图（3×3 排满）', () => {
    const sheets = planContactSheets(9);
    expect(sheets.length).toBe(1);
    expect(sheets[0].pages).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sheets[0].cells.length).toBe(9);
  });

  it('10 页 → 2 张网格图（9 + 1）', () => {
    const sheets = planContactSheets(10);
    expect(sheets.length).toBe(2);
    expect(sheets[0].pages.length).toBe(SLIDES_PER_SHEET);
    expect(sheets[1].pages).toEqual([9]);
  });

  it('单元格坐标：行列递进、含 padding/gap', () => {
    const { cells } = planContactSheets(SLIDES_PER_SHEET)[0];
    const { gap, padding } = GRID;
    const { cellWidth, cellHeight } = gridCell({ width: 1920, height: 1080 });
    // 第 0 格在左上角 padding 处
    expect(cells[0]).toMatchObject({ page: 0, x: padding, y: padding, w: cellWidth, h: cellHeight });
    // 第 1 格右移一个 cell+gap，同一行
    expect(cells[1].x).toBe(padding + cellWidth + gap);
    expect(cells[1].y).toBe(padding);
    // 第 cols 格换行
    expect(cells[GRID.cols].x).toBe(padding);
    expect(cells[GRID.cols].y).toBe(padding + cellHeight + gap);
  });

  it('单元格按画布比例派生：16:9 默认 / 4:3 / 竖版（§七）', () => {
    // 16:9（缺省）：cellWidth=cellLong=600，cellHeight=round(600×1080/1920)=338，与历史写死值一致
    expect(gridCell({ width: 1920, height: 1080 })).toEqual({ cellWidth: 600, cellHeight: 338 });
    // 4:3：横版定宽，高按比例 round(600×768/1024)=450
    expect(gridCell({ width: 1024, height: 768 })).toEqual({ cellWidth: 600, cellHeight: 450 });
    // 竖版（h>w）：定高 cellLong=600，宽按比例 round(600×1080/1920)=338
    expect(gridCell({ width: 1080, height: 1920 })).toEqual({ cellWidth: 338, cellHeight: 600 });
    // 网格图整体尺寸随单元格比例变（4:3 比 16:9 高）
    const sheet169 = planContactSheets(1, { width: 1920, height: 1080 })[0];
    const sheet43 = planContactSheets(1, { width: 1024, height: 768 })[0];
    expect(sheet43.height).toBeGreaterThan(sheet169.height);
    expect(sheet43.width).toBe(sheet169.width); // 同列宽
  });

  it('页号连续映射到 cell.page（跨网格图也连续）', () => {
    const sheets = planContactSheets(SLIDES_PER_SHEET + 2);
    expect(sheets[1].cells[0].page).toBe(SLIDES_PER_SHEET);
    expect(sheets[1].cells[1].page).toBe(SLIDES_PER_SHEET + 1);
  });

  it('0 页 → 空', () => {
    expect(planContactSheets(0)).toEqual([]);
  });
});

describe('selectSheetBatch', () => {
  it('总数 ≤ 上限：一批全包', () => {
    const r = selectSheetBatch(5, 1);
    expect(r).toEqual({ startSheet: 0, endSheet: 5, totalBatches: 1, batchIndex: 1 });
  });

  it('超上限：分批，第 1 批取前 MAX 张', () => {
    const total = MAX_SHEETS_PER_CALL + 3;
    const b1 = selectSheetBatch(total, 1);
    expect(b1.startSheet).toBe(0);
    expect(b1.endSheet).toBe(MAX_SHEETS_PER_CALL);
    expect(b1.totalBatches).toBe(2);
    expect(b1.batchIndex).toBe(1);
    const b2 = selectSheetBatch(total, 2);
    expect(b2.startSheet).toBe(MAX_SHEETS_PER_CALL);
    expect(b2.endSheet).toBe(total);
    expect(b2.batchIndex).toBe(2);
  });

  it('越界 batch 钳到合法范围（batchIndex 与区间同步钳位）', () => {
    const total = MAX_SHEETS_PER_CALL + 1;
    const hi = selectSheetBatch(total, 99);
    expect(hi.startSheet).toBe(MAX_SHEETS_PER_CALL); // 钳到最后一批
    expect(hi.batchIndex).toBe(2);
    const lo = selectSheetBatch(total, 0);
    expect(lo.startSheet).toBe(0); // 钳到第一批
    expect(lo.batchIndex).toBe(1);
  });
});

describe('mapWithConcurrency — 有界并发 map', () => {
  const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('结果按输入顺序回填（与完成顺序无关）', async () => {
    // 反序延时：先入的慢、后入的快 → 完成顺序与输入相反，仍须按 index 回填
    const res = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await tick(ms);
      return ms * 2;
    });
    expect(res).toEqual([60, 20, 40]);
  });

  it('并发数受 limit 约束（峰值 = min(limit, 长度)）', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(5);
      active -= 1;
      return x;
    });
    expect(peak).toBe(2);
  });

  it('limit 超过长度：全并行、峰值只到长度', async () => {
    let active = 0;
    let peak = 0;
    const res = await mapWithConcurrency([1, 2, 3], 10, async (x) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick(3);
      active -= 1;
      return x * 10;
    });
    expect(peak).toBe(3);
    expect(res).toEqual([10, 20, 30]);
  });

  it('单条抛错 → 整体 reject（错误原样透传）', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }),
    ).rejects.toThrow('boom');
  });

  it('空输入 → 空结果（不起 worker）', async () => {
    const fn = vi.fn(async (x: number) => x);
    expect(await mapWithConcurrency([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
