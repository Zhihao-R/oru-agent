import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEMES, DEFAULT_SCHEME, VALID_SCHEMES } from '@/lib/themes';
import { resources } from '@shared/i18n/resources';

const indexCss = readFileSync(resolve(__dirname, '../../src/index.css'), 'utf-8');

describe('themes registry', () => {
  it('VALID_SCHEMES 与 THEMES 顺序对齐', () => {
    expect(VALID_SCHEMES).toEqual(THEMES.map((t) => t.id));
  });

  it('DEFAULT_SCHEME 在注册表里', () => {
    expect(THEMES.find((t) => t.id === DEFAULT_SCHEME)).toBeDefined();
  });

  it('每个非默认主题都在 src/index.css 里有 [data-theme="<id>"] 规则（明 + 暗）', () => {
    for (const t of THEMES) {
      if (t.id === DEFAULT_SCHEME) continue;
      const lightSelector = `:root[data-theme="${t.id}"]`;
      const darkSelector = `:root[data-theme="${t.id}"].dark`;
      expect(indexCss, `缺日间块: ${lightSelector}`).toContain(lightSelector);
      expect(indexCss, `缺夜间块: ${darkSelector}`).toContain(darkSelector);
    }
  });

  it('每个主题都在 i18n 配了显示名（数据⇄文案对账，加主题漏配 themeName 即红）', () => {
    // 显示名移出数据层后由此对账兜底——遍历随 THEMES 增长，比 settingsZh 的逐 id 断言更系统
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const themeName: Record<string, string> = (resources.zh.settings as any).general.appearance.themeName;
    for (const t of THEMES) {
      expect(themeName[t.id], `${t.id} 缺 themeName 配置`).toBeTruthy();
    }
  });

  it('默认主题用 :root 缺省块（不带 data-theme）', () => {
    expect(indexCss).toMatch(/^:root\s*\{/m);
    expect(indexCss).toMatch(/^\.dark\s*\{/m);
  });

  it('主题预览色板字段都齐', () => {
    for (const t of THEMES) {
      for (const mode of ['light', 'dark'] as const) {
        const s = t[mode];
        expect(s.bg).toMatch(/^#[0-9a-f]{6}$/i);
        expect(s.elev).toMatch(/^#[0-9a-f]{6}$/i);
        expect(s.accent).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  // 预览色板三格全是手抄 CSS 的 hex，改主题时漏同步任一格都会让设置页的卡片说谎，
  // 故三格都对账（原先只守 accent，bg/elev 改动无人兜底）
  it('每个主题的预览色板三格与 CSS 里声明的 token 一致', () => {
    for (const t of THEMES) {
      const lightBlock = extractBlock(
        indexCss,
        t.id === DEFAULT_SCHEME ? ':root' : `:root[data-theme="${t.id}"]`,
        /* skipDark */ true,
      );
      const darkBlock = extractBlock(
        indexCss,
        t.id === DEFAULT_SCHEME ? '.dark' : `:root[data-theme="${t.id}"].dark`,
        false,
      );
      const pairs = [
        ['--accent', 'accent'],
        ['--bg-canvas', 'bg'],
        ['--bg-elevated', 'elev'],
      ] as const;
      for (const [cssVar, field] of pairs) {
        expect(extractVar(lightBlock, cssVar)?.toLowerCase(), `${t.id} 日间 ${cssVar}`).toBe(
          t.light[field].toLowerCase(),
        );
        expect(extractVar(darkBlock, cssVar)?.toLowerCase(), `${t.id} 夜间 ${cssVar}`).toBe(
          t.dark[field].toLowerCase(),
        );
      }
    }
  });
});

/** 从 CSS 文本里抽出某个 selector 的第一个声明块体（不含大括号） */
function extractBlock(css: string, selector: string, skipDark: boolean): string {
  // 用最朴素的字符串扫，避开正则在嵌套花括号上的麻烦
  let from = 0;
  while (from < css.length) {
    const idx = css.indexOf(selector, from);
    if (idx === -1) return '';
    // 后面紧跟的应该是 ' {' 或 '{' 或 '.dark {'（如果 skipDark 且 selector 是 :root，要排除 :root.dark/:root[data-theme="x"].dark）
    const tail = css.slice(idx + selector.length, idx + selector.length + 30);
    if (skipDark && /^[.[]/.test(tail.trimStart())) {
      // 比如 :root.dark 或 :root[data-theme="..."]，跳过
      from = idx + selector.length;
      continue;
    }
    // selector 后必须（空白后）紧跟 '{' 才是真规则块——排除注释/其它选择器里出现的同名子串
    // （如 :root 注释里写「夜间在 .dark 里」会让 '.dark' 假命中）
    if (!/^\s*\{/.test(tail)) {
      from = idx + selector.length;
      continue;
    }
    const braceStart = css.indexOf('{', idx);
    const braceEnd = css.indexOf('}', braceStart);
    if (braceStart === -1 || braceEnd === -1) return '';
    return css.slice(braceStart + 1, braceEnd);
  }
  return '';
}

function extractVar(block: string, varName: string): string | null {
  const m = block.match(new RegExp(`${varName}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}
