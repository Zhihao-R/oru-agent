/**
 * 渲染层 i18next 引擎，也是渲染层唯一驱动「i18next 语言 + <html lang>」的地方——启动初值
 * 与运行时切换两条路都收在这。
 *
 * 同步 init：resources 内联给全（无 backend / 无 Suspense）。启动初值取自 localStorage 镜像
 * （getStoredLanguage），在 React 挂载前就把语言设对，消除"先中文再闪英文"。
 * <html lang> 同处、同一信源一并设好，不再让 index.html 内联脚本重复一套探测逻辑。
 *
 * 语言**状态**仍归 settingsStore（单一信源）；i18next 只作渲染引擎。组件读 useTranslation()
 * 拿 t()，但切换语言始终走 settingsStore.update({ language })，由 subscribe 调本文件的
 * applyLanguage——与"组件不直接调 lib/theme"的现有约定一致。
 *
 * 设计依据见 docs/tech/2026-06-24-language-switch-tech-design.md（语言复制 theme 双层架构）。
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';
import {
  getStoredLanguage,
  resolveEffective,
  setStoredLanguage,
  applyHtmlLang,
  type Lang,
} from '@/lib/language';

const initialEffective = resolveEffective(getStoredLanguage());

void i18n.use(initReactI18next).init({
  resources,
  lng: initialEffective,
  fallbackLng, // 'zh'：缺词回落中文（开发期护栏）
  defaultNS,
  interpolation: { escapeValue: false }, // React 自带转义
  react: { useSuspense: false }, // 资源全内联永不异步，关 Suspense 免去调用方包 <Suspense>
});
applyHtmlLang(initialEffective);

/**
 * 切换语言的单一副作用入口（对照 lib/theme 的 setMode）：写 localStorage 镜像 +
 * 切 i18next 运行时语言 + 更新 <html lang>。仅 settingsStore.subscribe 调用，组件不直接调。
 *
 * changeLanguage 当前永不失败（资源全内联、同步解析），故 void 即可；第 2 期若改 namespace
 * 懒加载（真异步、可能失败），这里要改成 await + 错误处理。
 */
export function applyLanguage(lang: Lang): void {
  setStoredLanguage(lang);
  const eff = resolveEffective(lang);
  void i18n.changeLanguage(eff);
  applyHtmlLang(eff);
}

export default i18n;
