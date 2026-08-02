/**
 * 回归：主窗 will-navigate 兜底裁决。
 *
 * 历史缺口：主进程只有 setWindowOpenHandler（拦 window.open / target=_blank），
 * 没有 will-navigate 拦截——任何漏加 target 的外链点击会把整个 App 整页导航到外站。
 * 安全边界本应落在主进程导航收口，shouldExternalize 即该裁决（2026-06-23 补）。
 */
import { describe, expect, it } from 'vitest';
import { shouldExternalize } from '../../electron/main/window/navigationGuard';

const DEV = 'http://localhost:5173';

describe('shouldExternalize（dev：有同源 origin）', () => {
  it('跨源外链 → 拦下外开', () => {
    expect(shouldExternalize('https://example.com/docs', DEV)).toBe(true);
    expect(shouldExternalize('http://evil.test/', DEV)).toBe(true);
  });

  it('同源导航（HMR / reload）→ 放行', () => {
    expect(shouldExternalize('http://localhost:5173/', DEV)).toBe(false);
    expect(shouldExternalize('http://localhost:5173/index.html', DEV)).toBe(false);
  });

  it('同前缀但不同端口 → 仍判跨源（按 origin 比对，非 startsWith）', () => {
    expect(shouldExternalize('http://localhost:51730/', DEV)).toBe(true);
  });

  it('本地协议 / 页内锚点 → 不拦', () => {
    expect(shouldExternalize('#某标题', DEV)).toBe(false);
    expect(shouldExternalize('oru-doc-img://local/p/d/a.png', DEV)).toBe(false);
    expect(shouldExternalize('mailto:a@b.com', DEV)).toBe(false);
  });
});

describe('shouldExternalize（生产：file:// 主文档，无同源 origin）', () => {
  it('任何 http(s) 整页导航都是外部 → 拦下外开', () => {
    expect(shouldExternalize('https://example.com', undefined)).toBe(true);
    expect(shouldExternalize('http://localhost:5173/', undefined)).toBe(true);
  });

  it('本地协议不拦', () => {
    expect(shouldExternalize('#x', undefined)).toBe(false);
    expect(shouldExternalize('file:///a/b.html', undefined)).toBe(false);
  });
});
