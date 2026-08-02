/** @vitest-environment jsdom */
/**
 * deck ⌥点的 DOM 就地提取（electron/preload/deckAsideExtract.ts）。
 * preload 跑在 webview 里没法整体单测，纯函数部分在这里用 jsdom 伪文档覆盖四档：
 * 命中 .slide / 留白 / 带选区 / 流式半截内容。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDeckAsideClickPayload, resolveAsideTarget } from '../../electron/preload/deckAsideExtract';

// jsdom 无布局引擎、innerText 为 undefined——提取函数按 innerText ?? textContent 兜底，
// 这里断言的文本都是 textContent 口径
beforeEach(() => {
  document.body.innerHTML = `
    <div class="slide"><h1>封面标题</h1><p>副标题</p></div>
    <section class="slide"><h2>市场规模</h2><ul><li id="hit">要点一</li></ul></section>
    <div class="slide"><p>没有标题元素的页
第二行内容</p></div>
    <div class="slide"></div>
  `;
});

function build(target: Element | null, selectionText = '') {
  return buildDeckAsideClickPayload({ doc: document, target, selectionText, x: 40, y: 30 });
}

describe('buildDeckAsideClickPayload', () => {
  it('命中 .slide：pageIndex 按文档序、pageText 取该页全文、坐标透传', () => {
    const payload = build(document.querySelector('#hit'));
    expect(payload.pageIndex).toBe(1);
    expect(payload.pageText).toContain('市场规模');
    expect(payload.pageText).toContain('要点一');
    expect(payload.selectionText).toBe('');
    expect(payload.x).toBe(40);
    expect(payload.y).toBe(30);
  });

  it('大纲口径：h1-h6 优先，无标题元素用首行文本兜底，空页为空串', () => {
    const payload = build(document.querySelector('#hit'));
    expect(payload.outline).toEqual(['封面标题', '市场规模', '没有标题元素的页', '']);
  });

  it('留白（没命中 .slide）：照样产出 payload，只带大纲——webview 内不能有死角', () => {
    const payload = build(document.body);
    expect(payload.pageIndex).toBe(-1);
    expect(payload.pageText).toBe('');
    expect(payload.outline).toHaveLength(4);
  });

  it('target 为 null（极端事件形态）按未命中处理', () => {
    expect(build(null).pageIndex).toBe(-1);
  });

  it('带选区：选区文本 trim 后透传', () => {
    const payload = build(document.querySelector('#hit'), '  选中文字 ');
    expect(payload.selectionText).toBe('选中文字');
  });

  it('流式半截：空页可命中，pageText 为空串、不抛错', () => {
    const slides = document.querySelectorAll('.slide');
    const payload = build(slides[3]);
    expect(payload.pageIndex).toBe(3);
    expect(payload.pageText).toBe('');
  });

  it('首行兜底超长时截 60 字加省略号', () => {
    document.body.innerHTML = `<div class="slide"><p>${'长'.repeat(70)}</p></div>`;
    const payload = build(document.querySelector('.slide'));
    expect(payload.outline[0]).toBe(`${'长'.repeat(60)}…`);
  });
});

describe('resolveAsideTarget', () => {
  it('框选未激活：原样返回 rawTarget，不退出框选、不查 elementFromPoint', () => {
    let exited = false;
    const hit = document.querySelector('#hit')!;
    const target = resolveAsideTarget({
      doc: document,
      rawTarget: hit,
      x: 40,
      y: 30,
      frameActive: false,
      exitFrame: () => { exited = true; },
    });
    expect(target).toBe(hit);
    expect(exited).toBe(false);
  });

  it('回归：框选 overlay 存在时提取仍命中页——先退出框选再取点下真实元素', () => {
    // 复现 bug 场景：全屏 overlay 盖住页面，e.target 是 overlay 而非页内元素
    const overlay = document.createElement('div');
    overlay.setAttribute('data-oru-frame-overlay', '1');
    document.documentElement.appendChild(overlay);
    const hit = document.querySelector('#hit')!;
    // jsdom 无布局引擎，手动模拟命中测试语义：overlay 还在 DOM（仍参与命中测试）
    // 时 elementFromPoint 只会命中全屏 overlay，移除后才命中底下真实元素。
    // 若实现把"退出框选"放在 elementFromPoint 之后（时序错误），这里会拿回 overlay。
    document.elementFromPoint = ((_x: number, _y: number) =>
      overlay.isConnected ? overlay : hit) satisfies Document['elementFromPoint'];

    const target = resolveAsideTarget({
      doc: document,
      rawTarget: overlay,
      x: 40,
      y: 30,
      frameActive: true,
      exitFrame: () => overlay.remove(), // 与 exitFrameMode 同口径：同步移除 overlay
    });

    expect(target).toBe(hit);
    expect(overlay.isConnected).toBe(false); // 框选已退出，不残留待命
    // 提取不再退化成 blank 档，命中第 1 页
    expect(build(target).pageIndex).toBe(1);
  });
});
