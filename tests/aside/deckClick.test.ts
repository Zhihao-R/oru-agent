/**
 * deck ⌥点的 host 侧翻译（src/aside/deckClick.ts）：
 * 优先级四档（主窗口选区 > deck 内选区 > 命中页 > blank）、label 措辞、坐标系换算。
 */
import { describe, expect, it } from 'vitest';
import type { AsideDeckClickPayload } from '@shared/types';
import { assembleDeckAsideClick, translateDeckAsideClick } from '@/aside/deckClick';

const base: AsideDeckClickPayload = {
  pageIndex: 1,
  pageText: '市场规模\n要点一',
  selectionText: '',
  outline: ['封面标题', '市场规模', '路线图'],
  x: 40,
  y: 30,
};

describe('translateDeckAsideClick 优先级', () => {
  it('主窗口选区压过 deck 内选区', () => {
    const r = translateDeckAsideClick({ ...base, selectionText: 'deck 内选中' }, '主窗口选中');
    expect(r).toEqual({
      type: 'selection',
      text: '主窗口选中',
      label: '“主窗口选中”',
      region: 'deck-preview',
    });
  });

  it('纯空白的主窗口选区不算选区，落到下一档', () => {
    const r = translateDeckAsideClick(base, '   ');
    expect(r.type).toBe('deck-page');
  });

  it('deck 内选区压过命中页，surround 带所在页全文', () => {
    const r = translateDeckAsideClick({ ...base, selectionText: '页内选中' }, '');
    expect(r).toEqual({
      type: 'selection',
      text: '页内选中',
      surround: base.pageText,
      label: '“页内选中”',
      region: 'deck-preview',
    });
  });

  it('命中页 → deck-page：pageIndex / 页文本 / 编号大纲', () => {
    const r = translateDeckAsideClick(base, '');
    expect(r).toEqual({
      type: 'deck-page',
      pageIndex: 1,
      text: base.pageText,
      outline: '1. 封面标题\n2. 市场规模\n3. 路线图',
      label: '第 2 页 · 市场规模',
      region: 'deck-preview',
    });
  });

  it('没命中页 → blank，大纲进 context', () => {
    const r = translateDeckAsideClick({ ...base, pageIndex: -1, pageText: '' }, '');
    expect(r).toEqual({
      type: 'blank',
      context: '文稿大纲：\n1. 封面标题\n2. 市场规模\n3. 路线图',
      label: '文稿预览',
      region: 'deck-preview',
    });
  });

  it('blank 且无大纲（plain 文档）→ context 缺省', () => {
    const r = translateDeckAsideClick({ ...base, pageIndex: -1, pageText: '', outline: [] }, '');
    expect(r).toEqual({
      type: 'blank',
      context: undefined,
      label: '文稿预览',
      region: 'deck-preview',
    });
  });
});

describe('translateDeckAsideClick label 措辞', () => {
  it('页标题为空（流式半截）→ label 只有页号，大纲行标（无标题）', () => {
    const r = translateDeckAsideClick({ ...base, outline: ['封面标题', '', '路线图'] }, '');
    expect(r.label).toBe('第 2 页');
    expect(r.type === 'deck-page' && r.outline).toContain('2. （无标题）');
  });

  it('超长选区文本在 label 里截断，text 保持全文', () => {
    const long = '这段选中的文字相当长，远远超过指代卡标题能放下的宽度上限了';
    const r = translateDeckAsideClick({ ...base, selectionText: long }, '');
    expect(r.type === 'selection' && r.text).toBe(long);
    expect(r.label).toBe(`“${long.slice(0, 24)}…”`);
  });
});

describe('assembleDeckAsideClick 坐标系', () => {
  it('截图坐标 = webview 视口坐标原值（高 dpr 下截图已归一为逻辑像素，不乘 dpr）', () => {
    // 模拟 dpr=2 的机器：capturePage 物理产物 2x，但归一后截图即逻辑尺寸——标记点不偏
    const click = assembleDeckAsideClick({
      payload: base,
      hostSelectionText: '',
      screenshotBase64: 'UE5H',
      webviewRect: { left: 300, top: 48 },
    });
    expect(click.screenshot).toEqual({ base64: 'UE5H', x: 40, y: 30 });
    // 浮层定位用主窗口坐标 = webview 偏移 + 点内偏移
    expect(click.position).toEqual({ x: 340, y: 78 });
  });

  it('截图失败/超时 → screenshot 缺省，referent 与 position 照常', () => {
    const click = assembleDeckAsideClick({
      payload: base,
      hostSelectionText: '',
      webviewRect: { left: 0, top: 0 },
    });
    expect(click.screenshot).toBeUndefined();
    expect(click.referent.type).toBe('deck-page');
    expect(click.position).toEqual({ x: 40, y: 30 });
  });
});
