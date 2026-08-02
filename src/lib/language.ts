/**
 * 界面语言工具——对照 src/lib/theme.ts 的「存储 + 解析」层。
 *
 * - 权威态在 `Settings.language`（后端 config，随用户目录持久化、重装保留）；
 *   localStorage `oru.language` 是前端启动镜像，供 i18n.ts 启动期读取。
 * - `'system'` 由 resolveEffective 归约成 `'zh' | 'en'`：非中文一律 `'en'`（PRD：日/德/法等落英文）。
 * - **不监听 OS 语言变化**（与 theme 监听 prefers-color-scheme 不同）：语言运行中几乎不变、
 *   重载资源成本高，下次启动重算即可。
 *
 * 刻意不 import i18next：本模块是纯模型层（存储 + 解析 + `<html lang>` 写入助手）。切换语言的
 * 副作用（changeLanguage / 设 <html lang>）统一收在 i18n.ts，避免 language.ts ↔ i18n.ts 循环依赖。
 */

export type Lang = 'zh' | 'en' | 'system';

const STORAGE_KEY = 'oru.language';

export function getStoredLanguage(): Lang {
  // try/catch 覆盖：SSR（无 window）/ Safari 隐私模式（throws）/ 测试环境 stub
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'zh' || raw === 'en' || raw === 'system') return raw;
  } catch {
    /* fall through */
  }
  return 'system';
}

export function setStoredLanguage(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* Safari 隐私模式 / 测试环境忽略 */
  }
}

/** 把任意 Lang 归约成实际渲染语言；`'system'` 看浏览器语言，非中文一律 `'en'`。 */
export function resolveEffective(lang: Lang): 'zh' | 'en' {
  if (lang === 'zh' || lang === 'en') return lang;
  // navigator 在渲染进程 / Node18+ / jsdom 里都在；缺失时取空串 → 落 'en'，与"非中文一律 en"一致。
  const sys = typeof navigator !== 'undefined' ? navigator.language : '';
  return sys.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 把 `<html lang>` 设为当前有效语言（a11y / 拼写检查用）。由 i18n.ts 在启动与切换时调用。 */
export function applyHtmlLang(effective: 'zh' | 'en'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = effective === 'zh' ? 'zh-CN' : 'en';
}
