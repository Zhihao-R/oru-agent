/**
 * 主进程取词（D3）——面向用户的主进程文案（错误 / 通知 / 确认 / 平台流程）经此按 owner 语言取词。
 *
 * 与渲染层不对称是各自场景的正确解，不是不一致：渲染层全局 changeLanguage（单一当前语言）；主进程
 * 按 owner 读 settings、把 lang 当请求作用域局部值显式传入——**纪律：禁用 instance.changeLanguage()**，
 * 一律 getFixedT(lang) 按参取词，避免引入可变全局态、踩"await 后状态漂移"（见 CLAUDE.md 并发约定）。
 *
 * bundled resources、无异步 backend——init 的同步部分（装入 resources）即时完成，t() 在运行时
 * 调用（远晚于模块加载）一定就绪，故 init 不必 await（与渲染层 / Zh 测试同一 init 形态）。
 */
import { createInstance } from 'i18next';
import { resources, fallbackLng, defaultNS } from '@shared/i18n/resources';

const instance = createInstance();
void instance.init({
  resources,
  lng: fallbackLng,
  fallbackLng,
  defaultNS,
  interpolation: { escapeValue: false },
});

/** 按 owner 语言取词。lang 由 resolveEffectiveLang 归约自 Settings.language（见 ./effectiveLang）。 */
export function t(key: string, lang: 'zh' | 'en', params?: Record<string, unknown>): string {
  return instance.getFixedT(lang)(key, params);
}

/**
 * 绑定 lang 的取词器——给只认 `(key, params) => string` 的共享 formatter 用
 * （如 shared/scheduledTasks/describe 的 describeFrequency，主进程侧按 owner 语言传它）。
 */
export function tFor(lang: 'zh' | 'en'): (key: string, params?: Record<string, unknown>) => string {
  const fixed = instance.getFixedT(lang);
  return (key, params) => fixed(key, params);
}
