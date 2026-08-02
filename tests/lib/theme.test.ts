// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setColorScheme,
  getStoredColorScheme,
  initColorScheme,
  normalizeColorScheme,
} from '@/lib/theme';

// vitest 4 + jsdom 29 的 window.localStorage 是个不完整的 stub，缺 setItem/getItem/clear
// 在测试里用 in-memory Storage 替换掉
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

describe('colorScheme', () => {
  beforeEach(() => {
    installLocalStorageShim();
    document.documentElement.removeAttribute('data-theme');
  });

  it('setColorScheme("klein") 设 data-theme="klein" 并持久化', () => {
    setColorScheme('klein');
    expect(document.documentElement.getAttribute('data-theme')).toBe('klein');
    expect(window.localStorage.getItem('oru.colorScheme')).toBe('klein');
  });

  it('setColorScheme("terracotta") 移除 data-theme（缺省）', () => {
    document.documentElement.setAttribute('data-theme', 'klein');
    setColorScheme('terracotta');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem('oru.colorScheme')).toBe('terracotta');
  });

  it('连续切换覆盖前值', () => {
    setColorScheme('iris');
    setColorScheme('peacock');
    expect(document.documentElement.getAttribute('data-theme')).toBe('peacock');
  });

  it('getStoredColorScheme 缺省返回 terracotta', () => {
    expect(getStoredColorScheme()).toBe('terracotta');
  });

  it('getStoredColorScheme 返回已存的合法值', () => {
    window.localStorage.setItem('oru.colorScheme', 'klein');
    expect(getStoredColorScheme()).toBe('klein');
  });

  it('getStoredColorScheme 遇到非法值回落 terracotta', () => {
    window.localStorage.setItem('oru.colorScheme', 'foo');
    expect(getStoredColorScheme()).toBe('terracotta');
  });

  it('normalizeColorScheme 防御未知输入', () => {
    expect(normalizeColorScheme('klein')).toBe('klein');
    expect(normalizeColorScheme('foo')).toBe('terracotta');
    // 已下架主题的存量 id（2026-07 主题重做撤掉 sage/graphite）回落默认
    expect(normalizeColorScheme('sage')).toBe('terracotta');
    expect(normalizeColorScheme('graphite')).toBe('terracotta');
    expect(normalizeColorScheme(null)).toBe('terracotta');
    expect(normalizeColorScheme(undefined)).toBe('terracotta');
    expect(normalizeColorScheme(42)).toBe('terracotta');
  });

  it('initColorScheme 读 localStorage 并应用到 DOM', () => {
    window.localStorage.setItem('oru.colorScheme', 'ember');
    initColorScheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('ember');
  });

  it('initColorScheme 无 localStorage 时不设 attr（缺省赤陶）', () => {
    initColorScheme();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
