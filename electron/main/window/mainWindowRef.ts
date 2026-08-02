/**
 * 主窗口引用登记处——index.ts 创建/关闭时登记，其他主进程模块（aside 截图等）经此取用。
 * 不直接 import index.ts：那会把 app 启动副作用拽进依赖图，且与 ws/router 成环。
 */
import type { BrowserWindow } from 'electron';

let mainWindow: BrowserWindow | null = null;

/** index.ts 专用：createMainWindow 后登记，'closed' 时传 null 清除（登记/清除成对出现） */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/** 当前主窗口；未创建或已销毁返回 null（销毁后的引用调 webContents 会抛，这里先挡掉） */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}
