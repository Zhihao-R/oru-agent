/**
 * 测试全局 i18n 初始化（vitest setupFiles）。
 *
 * 渲染真组件的测试里 useTranslation 会回落到全局默认 i18next 实例——这里用 zh 资源把它
 * init 好，让 t() 在测试中返回真实中文（与抽 i18n 之前的硬编码中文等价），既有断言不破。
 * 显式 lng:'zh'（不依赖 navigator 探测），fallbackLng 仍兜。
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

// 把测试环境的语言探测钉死成 zh。`@/lib/i18n` 在被组件 import 时会按 localStorage→navigator
// 自跑一次 init（resolveEffective(getStoredLanguage())）：测试里 localStorage 无 oru.language → 落
// 'system' → 看 navigator.language（jsdom/node 都是 en-US）→ 解析成 en，会盖掉下面 setup 的 zh、
// 让既有中文断言全红。故在它加载前把 navigator.language 覆写成中文（改 app 真正读取的环境，而非往
// 生产代码塞测试分支）；只覆写 language 这一个属性、保留 userAgent 等（react-dom 渲染依赖之）。
// setupFiles 早于测试模块 import 执行，故先于 @/lib/i18n 生效。
try {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true });
} catch {
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...globalThis.navigator, language: 'zh-CN' },
    configurable: true,
  });
}

// 仅 jsdom（渲染真组件的测试）需要——node 端 ws/集成测试不渲染组件、不调 useTranslation，
// 跳过 init 省去无谓开销，也不扰动时序敏感的集成测试。
if (typeof document !== 'undefined') {
  void i18n.use(initReactI18next).init({
    resources,
    lng: 'zh',
    fallbackLng,
    defaultNS,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}
