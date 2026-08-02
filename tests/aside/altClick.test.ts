/** @vitest-environment jsdom */
/**
 * 主窗口 ⌥点事件接管（src/aside/useAsideAltClick.ts）的吞断模型——技术方案 §3.1/§10：
 * swallow 标记的置/清时机、click/dblclick 层吞断、豁免区域、键盘激活放行、
 * 以及"mousedown 读点之前的选区"的时序回归。
 * 用 installAsideAltClick 直接驱动真实事件序列，不经 React 渲染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws', () => {
  const wsClient = {
    request: async () => {
      throw new Error('本测试不应触网');
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'closed' as const,
  } satisfies import('@/lib/ws').OruWsClient;
  return { wsClient };
});

import { ASIDE_OVERLAY_ATTR, installAsideAltClick } from '@/aside/useAsideAltClick';
import { setAsideClickHandler, type AsideClick } from '@/aside/dispatch';

let uninstall: () => void;
let captured: AsideClick[];

beforeEach(() => {
  document.body.innerHTML = '';
  captured = [];
  setAsideClickHandler((click) => captured.push(click));
  uninstall = installAsideAltClick();
});

afterEach(() => {
  uninstall();
  setAsideClickHandler(null);
  window.getSelection()?.removeAllRanges();
});

function fire(
  target: EventTarget,
  type: 'mousedown' | 'click' | 'dblclick',
  init: MouseEventInit = {},
): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
  target.dispatchEvent(e);
  return e;
}

function addButton(text = '保存'): { btn: HTMLButtonElement; onClick: ReturnType<typeof vi.fn> } {
  const btn = document.createElement('button');
  btn.textContent = text;
  document.body.appendChild(btn);
  const onClick = vi.fn();
  btn.addEventListener('click', onClick);
  return { btn, onClick };
}

describe('⌥点吞断', () => {
  it('⌥点按钮：click 层吞（onClick 不触发、默认被断），dispatch 收到 control 指认与点击位置', () => {
    const { btn, onClick } = addButton();
    fire(btn, 'mousedown', { altKey: true, clientX: 12, clientY: 34 });
    const click = fire(btn, 'click', { altKey: true });
    expect(click.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0].referent).toMatchObject({ type: 'control', caption: '保存' });
    expect(captured[0].position).toEqual({ x: 12, y: 34 });
    // 截图不在本任务：留空，浮层 handler 自己截（先截后挂）
    expect(captured[0].screenshot).toBeUndefined();
  });

  it('⌥点 checkbox 不翻态（先验证普通点击确实翻态，防 jsdom 激活行为缺席假绿）', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    document.body.appendChild(box);
    fire(box, 'mousedown');
    fire(box, 'click');
    expect(box.checked).toBe(true); // 对照组：激活行为在场
    fire(box, 'mousedown', { altKey: true });
    fire(box, 'click', { altKey: true });
    expect(box.checked).toBe(true); // ⌥点被吞，没翻回 false
  });

  it('⌥点链接不跳转（click 默认被断）', () => {
    const a = document.createElement('a');
    a.href = '#elsewhere';
    a.textContent = '链接';
    document.body.appendChild(a);
    fire(a, 'mousedown', { altKey: true });
    expect(fire(a, 'click', { altKey: true }).defaultPrevented).toBe(true);
  });

  it('click 派发前已松开 ⌥：判标记不判 altKey，照样吞', () => {
    const { btn, onClick } = addButton();
    fire(btn, 'mousedown', { altKey: true });
    const click = fire(btn, 'click', { altKey: false });
    expect(click.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('⌥快速连点两下：click₁/click₂/dblclick 全吞（回归：click 清标记必挂），dispatch 两次', () => {
    const { btn, onClick } = addButton();
    fire(btn, 'mousedown', { altKey: true });
    const click1 = fire(btn, 'click', { altKey: true });
    fire(btn, 'mousedown', { altKey: true, detail: 2 });
    const click2 = fire(btn, 'click', { altKey: true, detail: 2 });
    const dbl = fire(btn, 'dblclick', { altKey: true, detail: 2 });
    expect(click1.defaultPrevented).toBe(true);
    expect(click2.defaultPrevented).toBe(true);
    expect(dbl.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(captured).toHaveLength(2);
  });

  it('普通点击全部无回归：不吞不挡、不 dispatch', () => {
    const { btn, onClick } = addButton();
    fire(btn, 'mousedown');
    const click = fire(btn, 'click');
    const dbl = fire(btn, 'dblclick', { detail: 2 });
    expect(click.defaultPrevented).toBe(false);
    expect(dbl.defaultPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
  });

  it('键盘 Enter/Space 激活（e.detail === 0）不被滞留标记误吞', () => {
    const { btn, onClick } = addButton();
    // 先 ⌥点别处制造滞留标记（click 不清标记，标记一直在）
    fire(document.body, 'mousedown', { altKey: true });
    fire(document.body, 'click', { altKey: true });
    // 键盘激活：无 mousedown 前导、detail === 0 → 放行
    const kbClick = fire(btn, 'click', { detail: 0 });
    expect(kbClick.defaultPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(1);
    // dblclick 的 detail === 0 同样放行（与 deck 版对称）
    expect(fire(btn, 'dblclick', { detail: 0 }).defaultPrevented).toBe(false);
  });

  it('mousedown 只 preventDefault 不 stopPropagation：document 级"外点关闭"照常收到', () => {
    const onDocMouseDown = vi.fn();
    document.addEventListener('mousedown', onDocMouseDown);
    const md = fire(document.body, 'mousedown', { altKey: true });
    expect(onDocMouseDown).toHaveBeenCalledTimes(1);
    expect(md.defaultPrevented).toBe(true); // 选区靠它保住
    document.removeEventListener('mousedown', onDocMouseDown);
  });
});

describe('豁免区域', () => {
  it.each([
    ['.cm-editor', () => {
      const editor = document.createElement('div');
      editor.className = 'cm-editor';
      return editor;
    }],
    [`[${ASIDE_OVERLAY_ATTR}]`, () => {
      const overlay = document.createElement('div');
      overlay.setAttribute(ASIDE_OVERLAY_ATTR, '');
      return overlay;
    }],
  ])('⌥按住点 %s 内：不 dispatch，且滞留标记被清、点击不被误吞', (_name, makeHost) => {
    const host = makeHost();
    document.body.appendChild(host);
    const inner = document.createElement('button');
    inner.textContent = '内部按钮';
    host.appendChild(inner);
    const onClick = vi.fn();
    inner.addEventListener('click', onClick);

    // 先 ⌥点别处制造滞留标记
    fire(document.body, 'mousedown', { altKey: true });
    expect(captured).toHaveLength(1);

    // ⌥按住点豁免区域：豁免路径同样走置/清，标记清零
    const md = fire(inner, 'mousedown', { altKey: true });
    expect(md.defaultPrevented).toBe(false);
    expect(captured).toHaveLength(1); // 没有新 dispatch
    const click = fire(inner, 'click', { altKey: true });
    expect(click.defaultPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('选区时序', () => {
  it('mousedown capture 读到"点之前"的选区（回归：换成 click 监听必挂）', () => {
    document.body.innerHTML = '<p id="text">这一段被选中的文字</p><div id="elsewhere"></div>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#text')!.firstChild as Text);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const elsewhere = document.querySelector('#elsewhere')!;
    fire(elsewhere, 'mousedown', { altKey: true });
    // 模拟浏览器在 click 派发前已清掉选区——靠 click 读选区的实现在这里必读空
    sel.removeAllRanges();
    fire(elsewhere, 'click', { altKey: true });

    expect(captured).toHaveLength(1);
    expect(captured[0].referent).toMatchObject({
      type: 'selection',
      text: '这一段被选中的文字',
    });
  });
});
