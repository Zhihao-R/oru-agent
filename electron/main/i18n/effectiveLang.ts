import { app } from 'electron';
import type { Settings } from '@shared/types';

/**
 * 主进程把 `Settings.language` 归约成实际语言——对照 `src/lib/language.ts` 的 resolveEffective，
 * 但 `'system'` 看 OS 语言（`app.getLocale()`）而非 navigator；非中文一律 `'en'`（PRD：日/德/法等落英文）。
 *
 * 用途（D4 回落）：无对话语言可判时（主动播报 / 定时任务起新空对话），据此给模型回落语言。
 * `undefined`（老用户没存过）等同 `'system'`，与渲染端一致。
 * `app` 在单测环境可能缺失，`?.` 防御——拿不到 OS 语言时落 `'en'`（与"非中文一律 en"同向）。
 */
export function resolveEffectiveLang(lang: Settings['language']): 'zh' | 'en' {
  if (lang === 'zh' || lang === 'en') return lang;
  const sys = app?.getLocale?.() ?? '';
  return sys.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
