/**
 * 唤起对话的承载窗（技术设计 §7 断点三）——浮在别 app 之上的独立透明渲染窗，渲染复用的 AsideOverlay。
 *
 * 关键约束（PoC §12 实测）：
 * - 须 `type:'panel'`（NSPanel）才能盖住别 app 的原生全屏 Space（风险 6），默认 BrowserWindow 盖不住。
 * - level 'screen-saver' + setVisibleOnAllWorkspaces({visibleOnFullScreen}) 浮到全屏之上。
 * - 透明置顶窗弹出不自动抢键盘焦点（风险 3）：native makeKeyNonactivating 让它单独拿焦点、不激活 app、
 *   不打断背后（「唤起即打字」）；native 缺席时退化 showInactive + focus()（需点一下输入框，dev 兜底）。
 * - 穿透与输入的矛盾：默认 setIgnoreMouseEvents(true,{forward:true}) 让透明处点击落到背后 app；
 *   浮层面板悬停时渲染端经 'overlay:setInteractive' 切回可交互（§7）。
 *
 * 单窗复用、按需重定位到点击所在 display（不每次新建，避免闪烁 + 重连 ws）。窗内浮层路径完全不动。
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { ScreenOverlayClick } from '@shared/types';
import { loadNativeDesktop } from './nativeDesktop';

let win: BrowserWindow | null = null;
let loaded = false;
let preloadPath = '';
let wsPort = 0;
/** 待投递的最后一次点击（含覆盖 bounds）——加载未完时挂这里，load 完成后由唯一 handler 补发（只发最后一次） */
let pendingShow: { click: ScreenOverlayClick; bounds: Electron.Rectangle } | null = null;

/** 一次性配置（index.ts 在 createMainWindow 时传入同一份 preload 与 ws 端口） */
export function configureOverlayWindow(opts: { preloadPath: string; wsPort: number }): void {
  preloadPath = opts.preloadPath;
  wsPort = opts.wsPort;
}

function rendererEntry(): { url?: string; file?: string } {
  // 第二渲染器入口 overlay.html（electron-vite 多 input）；dev 走 vite dev server，prod 走打包文件
  if (process.env.ELECTRON_RENDERER_URL) {
    return { url: `${process.env.ELECTRON_RENDERER_URL}/overlay.html` };
  }
  return { file: join(__dirname, '../renderer/overlay.html') };
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  loaded = false;
  win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    type: 'panel', // NSPanel：盖原生全屏 Space 的必要条件（§12 风险 6）
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--oru-ws-port=${wsPort}`, '--oru-overlay=1'],
    },
  });
  // 'screen-saver' 高 level 还兼一个隐性正确性：CGWindowList hit-test 只认 layer 0 普通窗，承载窗在高
  // layer 被跳过 → 分流不会把自己误命中为「Oru 窗」。若把 level 降到 normal，hit-test 会开始命中自己。
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认穿透（透明处点击落到背后 app）；悬停浮层面板时渲染端切回可交互
  win.setIgnoreMouseEvents(true, { forward: true });

  // type:'panel' 窗在 macOS 会把 app 的 activation policy 切成 accessory（Dock 图标消失、主窗最小化后
  // 召不回）。Oru 是有主窗的常规 app，建窗后立即拉回 regular 保住 Dock；panel 的盖全屏/不抢焦点靠
  // window level 与 showInactive，不依赖 app policy，不受影响。
  if (process.platform === 'darwin') app.setActivationPolicy('regular');

  const entry = rendererEntry();
  // 唯一的 load handler：加载完成即补发挂起的最后一次点击（不在 showScreenOverlay 里 per-call 挂 once，
  // 否则加载期多次 show 会堆叠多个 once、全部触发 → 多次 send）
  win.webContents.once('did-finish-load', () => {
    loaded = true;
    flushPending();
  });
  if (entry.url) void win.loadURL(entry.url);
  else if (entry.file) void win.loadFile(entry.file);
  win.on('closed', () => {
    win = null;
    loaded = false;
    pendingShow = null;
  });
  return win;
}

/**
 * 在 display 上弹出浮层并投递这次点击。bounds 来自截图编排（点击所在 display 的逻辑 bounds）。
 * 加载未完时只记为 pending（覆盖前一次），load 完成由唯一 handler 补发；已加载则立即发。
 */
export function showScreenOverlay(click: ScreenOverlayClick, bounds: Electron.Rectangle): void {
  ensureWindow();
  pendingShow = { click, bounds };
  if (loaded) flushPending();
}

/** 投递挂起的最后一次点击：定位到目标 display、推 IPC、showInactive 不抢前台、native nonactivating 拿焦点 */
function flushPending(): void {
  if (!pendingShow || !win || win.isDestroyed()) return;
  const { click, bounds } = pendingShow;
  pendingShow = null;
  win.setBounds(bounds);
  win.webContents.send('overlay:click', click);
  win.showInactive(); // 不激活 app、不抢前台
  focusNonactivating(win);
}

/** 让承载窗单独拿键盘焦点而不激活 app：native NSPanel nonactivating；缺席则退化 focus（dev 兜底） */
function focusNonactivating(w: BrowserWindow): void {
  const native = loadNativeDesktop();
  if (native) {
    try {
      native.makeKeyNonactivating(w.getNativeWindowHandle());
      return;
    } catch (e) {
      console.warn('[desktop.overlay] nonactivating 聚焦失败:', e instanceof Error ? e.message : e);
    }
  }
  w.focus();
}

/** 渲染端悬停浮层面板时切可交互 / 离开切穿透（§7 穿透与输入的矛盾） */
export function setOverlayInteractive(interactive: boolean): void {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!interactive, { forward: true });
}

/** 关闭浮层窗（隐藏即可，下次重用）——外点 / ESC / promote 后渲染端经 'overlay:close' 触发 */
export function hideScreenOverlay(): void {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
}

/** 销毁（before-quit）——注册/销毁成对 */
export function destroyOverlayWindow(): void {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  loaded = false;
}
