/**
 * render_html 纯函数单测：入参校验（parseRenderInput）+ 文案拼装（formatRenderText）。
 * 不碰 Electron——渲染原语本身在 electron smoke 里验（npm run smoke:render）。
 */
import { describe, it, expect } from 'vitest';
import {
  parseRenderInput,
  formatRenderText,
} from '../../electron/main/agent/agentTools/renderHtmlInput';

describe('parseRenderInput', () => {
  it('path 与 html 都缺 → 报错', () => {
    const r = parseRenderInput({});
    expect('error' in r && r.error).toMatch(/必须提供 path.*或 html/);
  });

  it('path 与 html 同时给 → 报错', () => {
    const r = parseRenderInput({ path: '/a/b.html', html: '<p>x</p>', base_dir: '/a' });
    expect('error' in r && r.error).toMatch(/只能给一个/);
  });

  it('html 不带 base_dir → 报错', () => {
    const r = parseRenderInput({ html: '<p>x</p>' });
    expect('error' in r && r.error).toMatch(/base_dir/);
  });

  it('合法 file 入参 → file source；不给视口则留 undefined（默认值归原语兜底）', () => {
    const r = parseRenderInput({ path: '  /deck/page.html  ' });
    expect('req' in r).toBe(true);
    if ('req' in r) {
      expect(r.req.source).toEqual({ kind: 'file', path: '/deck/page.html' });
      expect(r.req.viewport).toBeUndefined();
      expect(r.req.scrollY).toBeUndefined();
    }
  });

  it('合法 inline 入参 → inline source 带 baseDir', () => {
    const r = parseRenderInput({ html: '<h1>Hi</h1>', base_dir: '/deck' });
    expect('req' in r).toBe(true);
    if ('req' in r) {
      expect(r.req.source).toEqual({ kind: 'inline', html: '<h1>Hi</h1>', baseDir: '/deck' });
    }
  });

  it('scroll_y 负数 → 报错', () => {
    const r = parseRenderInput({ path: '/a.html', scroll_y: -10 });
    expect('error' in r && r.error).toMatch(/scroll_y/);
  });

  it('scroll_y / viewport 传 NaN/Infinity → 报错（钉住 Number.isFinite 分支）', () => {
    expect('error' in parseRenderInput({ path: '/a.html', scroll_y: NaN })).toBe(true);
    expect('error' in parseRenderInput({ path: '/a.html', scroll_y: Infinity })).toBe(true);
    expect(
      'error' in parseRenderInput({ path: '/a.html', viewport_width: Infinity, viewport_height: 1080 }),
    ).toBe(true);
    expect(
      'error' in parseRenderInput({ path: '/a.html', viewport_width: 1920, viewport_height: NaN }),
    ).toBe(true);
  });

  it('scroll_y=0 合法（首屏）', () => {
    const r = parseRenderInput({ path: '/a.html', scroll_y: 0 });
    expect('req' in r && r.req.scrollY).toBe(0);
  });

  it('viewport 非正数 → 报错', () => {
    expect('error' in parseRenderInput({ path: '/a.html', viewport_width: 0, viewport_height: 1080 })).toBe(true);
    expect('error' in parseRenderInput({ path: '/a.html', viewport_width: 1920, viewport_height: -1 })).toBe(true);
  });

  it('viewport 只给一边 → 报错（要么都给要么都不给）', () => {
    const r = parseRenderInput({ path: '/a.html', viewport_width: 1280 });
    expect('error' in r && r.error).toMatch(/要么都给/);
  });

  it('viewport 两边都给 → 自定义视口', () => {
    const r = parseRenderInput({ path: '/a.html', viewport_width: 1280, viewport_height: 720 });
    expect('req' in r && r.req.viewport).toEqual({ width: 1280, height: 720 });
  });
});

describe('formatRenderText', () => {
  const base = { width: 1920, height: 1080, contentHeight: 1080, hasMore: false, isBlank: false, scrollY: 0 };

  it('首屏、单屏页 → 只报视口与总高', () => {
    const t = formatRenderText(base);
    expect(t).toContain('已渲染首屏');
    expect(t).toContain('1920×1080');
    expect(t).not.toContain('scroll_y');
    expect(t).not.toContain('全白');
  });

  it('长页首屏 → 提示下一屏的 scroll_y', () => {
    const t = formatRenderText({ ...base, contentHeight: 3240, hasMore: true });
    expect(t).toContain('scroll_y=1080');
  });

  it('非首屏 → 文案标明从哪里截', () => {
    const t = formatRenderText({ ...base, contentHeight: 3240, hasMore: true, scrollY: 1080 });
    expect(t).toContain('从 1080px 处');
    expect(t).toContain('scroll_y=2160');
  });

  it('空白屏 → 给出排查提示', () => {
    const t = formatRenderText({ ...base, isBlank: true });
    expect(t).toContain('全白');
  });
});
