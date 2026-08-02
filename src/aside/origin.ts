/**
 * ⌥ 点来源标记——同一套 overlayMachine / pendingReferents 跑在两个渲染器里：
 * 主窗（窗内老路，缺省 'window'）与独立浮层窗（唤起对话，入口注入 'screen'）。
 * 仅用于给 aside.* 请求带 origin，让主进程计数分「窗外」维度（PRD §9）——不影响任何行为分支。
 *
 * 注入而非 import 常量：两个渲染器是各自独立的模块图实例，浮层窗入口调一次 setAsideOrigin('screen')
 * 即覆盖该进程内所有 aside 请求，主窗不调即保持窗内——零侵入窗内路径。
 */
import type { AsideOrigin } from '@shared/protocol';

let origin: AsideOrigin = 'window';

/** 浮层窗入口启动时调一次（'screen'）；主窗不调 */
export function setAsideOrigin(o: AsideOrigin): void {
  origin = o;
}

/**
 * aside.* 请求的来源字段——仅 'screen' 时返回 `{ origin: 'screen' }`，窗内返回 `{}`，
 * 让窗内请求线格式与历史完全一致（不平白多带字段，既有用例不动）。
 */
export function asideOriginField(): { origin?: AsideOrigin } {
  return origin === 'screen' ? { origin } : {};
}
