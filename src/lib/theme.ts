/**
 * 主题切换工具
 * - 明暗模式：在 document.documentElement 上加/去 dark class，持久化到 localStorage
 * - 配色主题：在 document.documentElement 上设/去 data-theme attr，持久化到 localStorage
 * - 支持 system 明暗模式（监听 prefers-color-scheme）
 */

import type { ColorScheme } from '@shared/types';
import { DEFAULT_SCHEME, VALID_SCHEMES } from '@/lib/themes';

export type ThemeMode = 'light' | 'dark' | 'system';
export type { ColorScheme };

const STORAGE_KEY = 'oru.theme';
const COLOR_SCHEME_KEY = 'oru.colorScheme';

let mediaQuery: MediaQueryList | null = null;
let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

function resolveEffective(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

function applyToDom(effective: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (effective === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

export function getStoredMode(): ThemeMode {
  // try/catch 覆盖：SSR（无 window）/ Safari 隐私模式（throws）/ 测试环境 stub
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* fall through */
  }
  return 'system';
}

export function setMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* Safari 隐私模式 / 测试环境忽略 */
  }
  applyToDom(resolveEffective(mode));
  bindSystemListener(mode);
}

function bindSystemListener(mode: ThemeMode): void {
  if (typeof window === 'undefined') return;
  if (mediaQuery && systemListener) {
    mediaQuery.removeEventListener('change', systemListener);
    mediaQuery = null;
    systemListener = null;
  }
  if (mode !== 'system') return;
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  systemListener = (e) => applyToDom(e.matches ? 'dark' : 'light');
  mediaQuery.addEventListener('change', systemListener);
}

export function initTheme(): ThemeMode {
  const mode = getStoredMode();
  applyToDom(resolveEffective(mode));
  bindSystemListener(mode);
  return mode;
}

/** 纯函数——返回下一档 mode（light → dark → system → light）。副作用由调用方处理。 */
export function nextThemeMode(current: ThemeMode): ThemeMode {
  return current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
}

export function effectiveMode(mode: ThemeMode): 'light' | 'dark' {
  return resolveEffective(mode);
}

// ─── 配色主题 ─────────────────────────────────────────

/** 把任意输入归一为合法 ColorScheme，未知值回落到默认主题 */
export function normalizeColorScheme(value: unknown): ColorScheme {
  if (typeof value === 'string' && (VALID_SCHEMES as readonly string[]).includes(value)) {
    return value as ColorScheme;
  }
  return DEFAULT_SCHEME;
}

export function getStoredColorScheme(): ColorScheme {
  try {
    return normalizeColorScheme(window.localStorage.getItem(COLOR_SCHEME_KEY));
  } catch {
    return DEFAULT_SCHEME;
  }
}

export function setColorScheme(scheme: ColorScheme): void {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  if (scheme === DEFAULT_SCHEME) {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', scheme);
  }
  try {
    window.localStorage.setItem(COLOR_SCHEME_KEY, scheme);
  } catch {
    /* Safari 隐私模式 / 测试环境忽略 */
  }
}

/** 启动期调用：读 localStorage 把当前主题应用到 DOM，返回最终值 */
export function initColorScheme(): ColorScheme {
  const scheme = getStoredColorScheme();
  setColorScheme(scheme);
  return scheme;
}
