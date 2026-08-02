import { create } from 'zustand';
import type { AuthStatus, Settings } from '@shared/types';
import { wsClient } from '@/lib/ws';
import {
  getStoredColorScheme,
  getStoredMode,
  normalizeColorScheme,
  setColorScheme as applyColorScheme,
  setMode as applyThemeMode,
} from '@/lib/theme';
import { getStoredLanguage } from '@/lib/language';
import i18n, { applyLanguage } from '@/lib/i18n';

// 启动期 React state 与 DOM 看到的是同一份（DOM 由 index.html 内联脚本按 localStorage 应用）
const defaultSettings: Settings = {
  theme: getStoredMode(),
  colorScheme: getStoredColorScheme(),
  language: getStoredLanguage(),
  manualApiKey: null,
  providers: [],
  models: [],
  modelAssignments: {
    twinMain: null,
    twinBackground: null,
    memoryDream: null,
    subagentCoder: null,
    conversationSummary: null,
    conversationTitle: null,
    twinSubagent: null,
    asideComment: null,
    loopReviewer: null,
    memoryRecall: null,
    scheduledRun: null,
    loopCompile: null,
  },
  migratedFromManualApiKey: false,
  mcpServers: [],
  webSearch: {
    enabled: false,
    engines: [],
    longPageSummary: true,
  },
};

/**
 * 主进程来的 settings 落 store 前统一归一（syncSettings 与 refresh 两条到达路径共用）：
 * colorScheme 盘上可能躺着已下架主题的 id（如 2026-07 撤掉的 sage/graphite），
 * 未知值回落默认主题，避免 data-theme 挂脏值 + 选择器空选中态。
 */
function normalizeSettings(settings: Settings): Settings {
  return { ...settings, colorScheme: normalizeColorScheme(settings.colorScheme) };
}

// authStatus 语义：主对话是否有可用模型后端（多 backend 时代不再单指 Claude 鉴权），
// 由主进程 readiness.mainChatStatus 产出——输入禁用 / 顶栏徽章 / 提示横幅都只看它。
const defaultAuth: AuthStatus = {
  ready: false,
  // 模块加载时取词：i18n 在本模块 import 时已同步 init（见 lib/i18n）；初始「检测中」态，鉴权结果到达即被覆盖
  hint: i18n.t('app:auth.checking'),
};

/**
 * 开发者模式解锁状态——本会话生命周期内有效（重启失效，维护 PRD 「藏」的初衷）。
 * 走 sessionStorage 而不是 localStorage：每次启动 app 自动重新隐藏。
 */
const DEV_MODE_KEY = 'oru.devModeUnlocked';
function readDevModeUnlocked(): boolean {
  try {
    return sessionStorage.getItem(DEV_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

type SettingsStoreState = {
  settings: Settings;
  authStatus: AuthStatus;
  /** 开发者模式是否解锁（5 次点击版本号触发） */
  devModeUnlocked: boolean;
  syncSettings: (settings: Settings) => void;
  syncAuth: (status: AuthStatus) => void;
  refresh: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  update: (patch: Partial<Settings>) => Promise<void>;
  setDevModeUnlocked: (on: boolean) => void;
};

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  settings: defaultSettings,
  authStatus: defaultAuth,
  devModeUnlocked: readDevModeUnlocked(),
  syncSettings: (settings) => set({ settings: normalizeSettings(settings) }),
  syncAuth: (authStatus) => set({ authStatus }),
  setDevModeUnlocked: (on) => {
    try {
      if (on) sessionStorage.setItem(DEV_MODE_KEY, 'true');
      else sessionStorage.removeItem(DEV_MODE_KEY);
    } catch {
      // 隐私模式忽略
    }
    set({ devModeUnlocked: on });
  },
  async refresh() {
    try {
      const res = await wsClient.request({ type: 'settings.get' });
      if (res.type === 'settings.state') {
        set({ settings: normalizeSettings(res.settings) });
      }
    } catch {
      // 忽略：未连接时
    }
  },
  async refreshAuth() {
    try {
      const res = await wsClient.request({ type: 'auth.status' });
      if (res.type === 'auth.status') {
        set({ authStatus: res.status });
      }
    } catch {
      // 忽略
    }
  },
  async update(patch) {
    // 乐观更新——立刻反映到 UI（主题切换等不必等 WS 往返），再异步同步后端；
    // 后端最终通过 settings.state 事件回写权威值。注意：与 agentStore.update 等
    // 后写本地的 store 语义不同，主题/外观这类高频小开关需要无延迟反馈。
    set((prev) => ({ settings: { ...prev.settings, ...patch } }));
    try {
      const res = await wsClient.request({ type: 'settings.update', settings: patch });
      if (res.type === 'settings.state') {
        set({ settings: res.settings });
      }
    } catch {
      // 忽略——本地已乐观更新，断连/失败时后端最终会通过 settings.state 修正
    }
  },
}));

/**
 * settings.theme / settings.colorScheme → DOM/localStorage 单向投射。
 *
 * 唯一胶水：所有写入路径（update / syncSettings / refresh）都通过 store，
 * subscribe 自动把 theme/colorScheme 应用到 DOM。组件不需要也不应该直接
 * 调 lib/theme 的 setMode / setColorScheme——store 就是单一信源。
 *
 * 启动期：index.html 内联脚本已按 localStorage 把 DOM 准备好，defaultSettings
 * 也从 localStorage 读初值，两者一致；App.tsx 的 initTheme/initColorScheme 负责
 * 绑 system listener 等一次性 side effect。subscribe 只在变化时触发。
 */
useSettingsStore.subscribe((state, prev) => {
  if (state.settings.theme !== prev.settings.theme) {
    applyThemeMode(state.settings.theme);
  }
  if (state.settings.colorScheme !== prev.settings.colorScheme) {
    applyColorScheme(state.settings.colorScheme);
  }
  if (state.settings.language !== prev.settings.language) {
    // language 是可选字段（老 config 可能缺）：缺省按 'system'，applyLanguage 幂等
    applyLanguage(state.settings.language ?? 'system');
  }
});
