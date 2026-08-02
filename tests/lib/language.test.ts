// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getStoredLanguage,
  setStoredLanguage,
  resolveEffective,
  applyHtmlLang,
} from '@/lib/language';

// 与 theme.test.ts 同款：vitest 4 + jsdom 29 的 window.localStorage 是不完整 stub，用 in-memory 替换
function installLocalStorageShim() {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(window, 'localStorage', {
    value: shim,
    writable: true,
    configurable: true,
  });
}

/** 覆写 navigator.language（jsdom 默认 en-US），测 system 归约两个方向 */
function setNavigatorLanguage(lang: string) {
  Object.defineProperty(window.navigator, 'language', {
    value: lang,
    writable: true,
    configurable: true,
  });
}

describe('language', () => {
  beforeEach(() => {
    installLocalStorageShim();
    document.documentElement.removeAttribute('lang');
  });

  afterEach(() => {
    setNavigatorLanguage('en-US');
  });

  it('getStoredLanguage 缺省返回 system', () => {
    expect(getStoredLanguage()).toBe('system');
  });

  it('getStoredLanguage 返回已存的合法值', () => {
    window.localStorage.setItem('oru.language', 'en');
    expect(getStoredLanguage()).toBe('en');
  });

  it('getStoredLanguage 遇到非法值回落 system', () => {
    window.localStorage.setItem('oru.language', 'fr');
    expect(getStoredLanguage()).toBe('system');
  });

  it('setStoredLanguage 持久化', () => {
    setStoredLanguage('zh');
    expect(window.localStorage.getItem('oru.language')).toBe('zh');
  });

  it('resolveEffective 显式 zh/en 原样返回', () => {
    expect(resolveEffective('zh')).toBe('zh');
    expect(resolveEffective('en')).toBe('en');
  });

  it('resolveEffective(system) 中文系统 → zh', () => {
    setNavigatorLanguage('zh-CN');
    expect(resolveEffective('system')).toBe('zh');
  });

  it('resolveEffective(system) 非中文系统（含日德法）一律 → en', () => {
    setNavigatorLanguage('ja-JP');
    expect(resolveEffective('system')).toBe('en');
    setNavigatorLanguage('de-DE');
    expect(resolveEffective('system')).toBe('en');
    setNavigatorLanguage('en-US');
    expect(resolveEffective('system')).toBe('en');
  });

  it('applyHtmlLang 写 <html lang>', () => {
    applyHtmlLang('en');
    expect(document.documentElement.lang).toBe('en');
    applyHtmlLang('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});
