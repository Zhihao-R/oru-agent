/**
 * 主题注册表 —— 加 / 删 / 改主题的唯一入口
 *
 * 加新主题四步走：
 *   1. 把 id 加进 shared/types.ts 的 ColorScheme union
 *   2. 在本文件 THEMES 里加一项（TS 会强制 id 和 union 对齐）
 *   3. 在 src/index.css 加 :root[data-theme="<id>"] 和 .dark 嵌套块
 *      （tests/lib/themes.test.ts 会 fail-fast 提醒漏 CSS）
 *   4. 在各语言包 locales/<lng>/settings.json 的 general.appearance.themeName 下加显示名
 *      （同上 themes.test.ts 会 fail-fast 提醒漏配 zh 显示名）
 *
 * 删主题：先从 union 删，TS 会报到所有引用点；CSS 块可留可删（无害）。
 */

import type { ColorScheme } from '@shared/types';

/** 默认主题。设这个 id 时不写 data-theme attr，回到 :root 缺省块 */
export const DEFAULT_SCHEME: ColorScheme = 'terracotta';

export type ThemeSwatch = {
  /** 背景层色，预览卡片左侧 */
  bg: string;
  /** 浮层色，预览卡片中间 */
  elev: string;
  /** 重音色，预览卡片右侧 */
  accent: string;
};

export type ThemeMeta = {
  id: ColorScheme;
  /** 预览色板 —— 只用于 SettingsDialog 卡片渲染，必须与 src/index.css 的核心色保持一致 */
  light: ThemeSwatch;
  dark: ThemeSwatch;
};

// 主题显示名是按 id 取的 UI 文案，归 settings:general.appearance.themeName.<id>，不留在数据层
export const THEMES: readonly ThemeMeta[] = [
  {
    id: 'terracotta',
    light: { bg: '#fbfdfe', elev: '#ffffff', accent: '#1b9e6b' },
    dark: { bg: '#131817', elev: '#1d2421', accent: '#41c795' },
  },
  {
    id: 'klein',
    light: { bg: '#fcfcfc', elev: '#ffffff', accent: '#002fa7' },
    dark: { bg: '#0f0f0f', elev: '#191919', accent: '#5c8aff' },
  },
  {
    id: 'ember',
    light: { bg: '#fefefd', elev: '#ffffff', accent: '#bc5b1f' },
    dark: { bg: '#16120e', elev: '#201b15', accent: '#e08a4a' },
  },
  {
    id: 'mono',
    light: { bg: '#fcfcfc', elev: '#ffffff', accent: '#161616' },
    dark: { bg: '#0f0f0f', elev: '#191919', accent: '#f2f2f2' },
  },
  {
    id: 'iris',
    light: { bg: '#fdfdfe', elev: '#ffffff', accent: '#5b4bbe' },
    dark: { bg: '#131019', elev: '#1c1826', accent: '#9d8cee' },
  },
  {
    id: 'peacock',
    light: { bg: '#fafdfe', elev: '#ffffff', accent: '#0d7089' },
    dark: { bg: '#0f161a', elev: '#172227', accent: '#3db4cd' },
  },
  {
    id: 'snowline',
    light: { bg: '#f9f8fb', elev: '#ffffff', accent: '#3f5530' },
    dark: { bg: '#17151c', elev: '#23202a', accent: '#9ebd7f' },
  },
];

/** 由 THEMES 派生出来的合法 id 集合，给 normalizeColorScheme 用 */
export const VALID_SCHEMES: readonly ColorScheme[] = THEMES.map((t) => t.id);
