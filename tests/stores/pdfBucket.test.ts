// @vitest-environment jsdom

/**
 * pdfStore 按 ref 分桶（PDF tech design §四）——纯同步视图态桶。
 * 核心断言：open/close 建删桶、重开保留现场、relocate 改名迁桶 key+absPath、closeIfUnder 删子树桶、
 * patch 只动本桶不串。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePdfStore } from '@/stores/pdfStore';

describe('pdfStore 分桶', () => {
  beforeEach(() => {
    usePdfStore.setState({ byRef: {} });
  });

  it('open 建桶（初值 zoom=1 / fitWidth=true / 空搜索）', () => {
    usePdfStore.getState().open('a.pdf', '/proj/a.pdf');
    const f = usePdfStore.getState().byRef['a.pdf']!;
    expect(f.absPath).toBe('/proj/a.pdf');
    expect(f.zoom).toBe(1);
    expect(f.fitWidth).toBe(true);
    expect(f.search).toEqual({ open: false, query: '', matches: [], activeIndex: -1 });
  });

  it('重开同一 ref 保留现场（不重置 zoom/scroll）', () => {
    usePdfStore.getState().open('a.pdf', '/proj/a.pdf');
    usePdfStore.getState().patch('a.pdf', { zoom: 2, scrollTop: 500 });
    usePdfStore.getState().open('a.pdf', '/proj/a.pdf'); // 重开
    const f = usePdfStore.getState().byRef['a.pdf']!;
    expect(f.zoom).toBe(2);
    expect(f.scrollTop).toBe(500);
  });

  it('patch 只动本桶，不串另一桶', () => {
    usePdfStore.getState().open('a.pdf', '/proj/a.pdf');
    usePdfStore.getState().open('b.pdf', '/proj/b.pdf');
    usePdfStore.getState().patch('a.pdf', { zoom: 3 });
    expect(usePdfStore.getState().byRef['a.pdf']!.zoom).toBe(3);
    expect(usePdfStore.getState().byRef['b.pdf']!.zoom).toBe(1);
  });

  it('patch 桶不在时忽略（不抛、不建桶）', () => {
    usePdfStore.getState().patch('ghost.pdf', { zoom: 2 });
    expect(usePdfStore.getState().byRef['ghost.pdf']).toBeUndefined();
  });

  it('close 只删该桶', () => {
    usePdfStore.getState().open('a.pdf', '/proj/a.pdf');
    usePdfStore.getState().open('b.pdf', '/proj/b.pdf');
    usePdfStore.getState().close('a.pdf');
    expect(Object.keys(usePdfStore.getState().byRef)).toEqual(['b.pdf']);
  });

  it('relocate：改名迁桶 key + absPath，视图态随迁', () => {
    usePdfStore.getState().open('old/a.pdf', '/proj/old/a.pdf');
    usePdfStore.getState().patch('old/a.pdf', { zoom: 1.5 });
    usePdfStore.getState().relocate('old/a.pdf', 'new/b.pdf');
    const s = usePdfStore.getState();
    expect(s.byRef['old/a.pdf']).toBeUndefined();
    expect(s.byRef['new/b.pdf']!.absPath).toBe('/proj/new/b.pdf');
    expect(s.byRef['new/b.pdf']!.zoom).toBe(1.5); // 态随桶迁移不丢
  });

  it('relocate：目录改名带动子树内 PDF', () => {
    usePdfStore.getState().open('docs/a.pdf', '/proj/docs/a.pdf');
    usePdfStore.getState().relocate('docs', 'archive');
    const s = usePdfStore.getState();
    expect(s.byRef['docs/a.pdf']).toBeUndefined();
    expect(s.byRef['archive/a.pdf']!.absPath).toBe('/proj/archive/a.pdf');
  });

  it('closeIfUnder：删目录关其下所有 PDF 桶', () => {
    usePdfStore.getState().open('docs/a.pdf', '/proj/docs/a.pdf');
    usePdfStore.getState().open('docs/sub/b.pdf', '/proj/docs/sub/b.pdf');
    usePdfStore.getState().open('other/c.pdf', '/proj/other/c.pdf');
    usePdfStore.getState().closeIfUnder('docs');
    expect(Object.keys(usePdfStore.getState().byRef)).toEqual(['other/c.pdf']);
  });
});
