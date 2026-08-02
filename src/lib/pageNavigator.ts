/**
 * 对话组件跳页的「缝」——页面切换是 App 的局部 state（同 setAsidePromoteNavigator 先例），
 * App 挂载时注册回调注入，本模块不碰 React。目前只有定时任务卡需要，收窄到用得上的页面；
 * 后续组件要跳别的页在联合类型里加即可。
 */
export type NavigablePage = 'scheduledTask';

let navigator: ((page: NavigablePage) => void) | null = null;

export function setPageNavigator(fn: ((page: NavigablePage) => void) | null): void {
  navigator = fn;
}

export function navigateToPage(page: NavigablePage): void {
  navigator?.(page);
}
