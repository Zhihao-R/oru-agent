/**
 * 唤起对话（系统级在场）的桌面常驻层编排（技术设计 §2 总体形状）——
 * 全局 ⌥ 触发 → 分流 → 截点击所在 display 整屏 → 推给独立浮层承载窗。窗内浮层路径完全不动。
 *
 * 开关由设置项「全局点睛」驱动：configureDesktopPresence 启动注入、setDesktopPresenceEnabled 起停、
 * disposeDesktopPresence 回收（before-quit / 关开关，成对）。权限引导在 设置→偏好→界面（替代旧 Tray）。
 * native（hit-test 分流 + NSPanel 聚焦）缺席时优雅降级：分流退化为「一律走全屏」、聚焦退化为「点一下输入框」——
 * 先主干跑通、后补 native（已定排期）。
 */
import { ipcMain } from 'electron';
import type { ScreenOverlayClick } from '@shared/types';
import { getMainWindow } from '../window/mainWindowRef';
import { startGlobalTrigger, stopGlobalTrigger, type ScreenTrigger } from './trigger';
import { captureScreenAtPoint } from './screenCapture';
import { hasScreenRecording, screenRecordingStatus } from './permissions';
import { loadNativeDesktop } from './nativeDesktop';
import {
  configureOverlayWindow,
  showScreenOverlay,
  setOverlayInteractive,
  hideScreenOverlay,
  destroyOverlayWindow,
} from './overlayWindow';

let started = false;
/** 全局触发的开/关——start 置真、dispose 置假，配 setTriggerActive 的 on===active 护栏防重复起停 */
let active = false;
/** 截屏在途互斥：一轮截屏+出窗未完时来的新触发记为 pending（只留最后一次），收尾后补跑——
 *  截屏串行不并发、且 last-wins（乱序完成的陈旧点击不会反胜）。连点的浮层层 last-wins 另由 overlayMachine 管。 */
let busy = false;
let pending: ScreenTrigger | null = null;
/** 当前浮层弹出前的前台 app pid——关浮层时切回它，把键盘焦点还给用户原来在用的那个 app */
let restorePid: number | undefined;

/** Oru 自己的窗口归属 pid——macOS 下各 BrowserWindow 的 NSWindow 都由主进程拥有（CGWindowOwnerPID = process.pid） */
function oruPids(): ReadonlySet<number> {
  return new Set([process.pid]);
}

/** 触发入口：在途则记最后一次、收尾补跑；空闲则起一轮 */
function onScreenTrigger(t: ScreenTrigger): void {
  if (busy) {
    pending = t; // trailing last-wins：截屏期间连点，只补跑最后一次
    return;
  }
  busy = true;
  void handleScreenClick(t)
    .catch((e) => console.warn('[desktop] 唤起处理失败:', e instanceof Error ? e.message : e))
    .finally(() => {
      busy = false;
      const next = pending;
      pending = null;
      if (next) onScreenTrigger(next);
    });
}

/**
 * 一次窗外 ⌥ 点：截点击所在 display 整屏 + 算两套坐标 → 推浮层窗。
 * 截屏失败（屏幕录制权限未授 / 抓帧空）→ 跳过本次：屏幕路径必须自带截图，否则 overlayMachine
 * 会回退去截主窗（screen 路径绝不能截到 Oru 主窗）。权限引导负责把这条坎讲清（§9）。
 */
async function handleScreenClick(t: ScreenTrigger): Promise<void> {
  const shot = await captureScreenAtPoint(t.point);
  if (!shot) {
    console.warn(
      `[desktop] 整屏截图失败，跳过本次唤起` +
        (hasScreenRecording() ? '（抓帧空，稍后重试）' : '（屏幕录制权限未授，去系统设置勾选后重启 App）'),
    );
    return;
  }
  const { bounds } = shot.display;
  const click: ScreenOverlayClick = {
    screenshot: shot.base64,
    shot: shot.click, // 截图坐标系内的聚光圈圆心
    position: { x: t.point.x - bounds.x, y: t.point.y - bounds.y }, // 浮层窗本地坐标
    app: t.app,
  };
  restorePid = t.restorePid; // 记下弹出前的前台 app，关浮层时切回（焦点交还）
  showScreenOverlay(click, bounds);
}

/** 外点/ESC 关浮层：隐窗 + 把前台还给弹出前那个 app（焦点交还，用户已定的「弹出即打字」收尾） */
function onOverlayDismiss(): void {
  hideScreenOverlay();
  if (restorePid !== undefined) {
    loadNativeDesktop()?.activateApp(restorePid);
    restorePid = undefined;
  }
}

/** 转正（↗）：把 Oru 主窗带到前台承接正式对话（main 列表已有该会话；conv.state 已广播） */
function onOverlayPromoted(): void {
  restorePid = undefined; // 转正后留在 Oru，不再切回背后 app
  const main = getMainWindow();
  if (main) {
    main.show();
    main.focus();
  }
}

/** 起/停全局触发——start 幂等，stop 顺带清在途状态 */
function setTriggerActive(on: boolean): void {
  if (on === active) return;
  if (on) {
    startGlobalTrigger({
      modifier: 'alt', // §11 触发修饰键可配（持久化设置）待接；先默认 ⌥
      oruPids,
      onScreenClick: onScreenTrigger,
    });
  } else {
    stopGlobalTrigger();
    busy = false;
    pending = null;
  }
  active = on;
}

/** 启动期注入一次 preload/wsPort（与主窗同源）——setDesktopPresenceEnabled(true) 据此拉起常驻层。 */
let bootOpts: { preloadPath: string; wsPort: number } | null = null;
export function configureDesktopPresence(opts: { preloadPath: string; wsPort: number }): void {
  bootOpts = opts;
}

/**
 * 全局点睛总开关（设置项「全局点睛」驱动，settings.update / 启动各调一次）。幂等：
 * 开→拉起常驻层（含申请系统权限）、关→回收。未 configure（无 preload/wsPort）时开为 no-op。
 */
export function setDesktopPresenceEnabled(on: boolean): void {
  if (on) startDesktopPresence();
  else disposeDesktopPresence();
}

/** 拉起桌面常驻层。preload/wsPort 取自 configureDesktopPresence。dispose 与之成对。 */
function startDesktopPresence(): void {
  if (started) return;
  if (!bootOpts) {
    console.warn('[desktop] 未配置 preload/wsPort，跳过启动');
    return;
  }
  console.log(
    `[desktop] 启动唤起对话桌面层；屏幕录制权限=${screenRecordingStatus()}` +
      `（输入监控权限无 API 可查，未授则 uiohook 收不到全局点击）`,
  );
  configureOverlayWindow({ preloadPath: bootOpts.preloadPath, wsPort: bootOpts.wsPort });

  // 浮层渲染端的窗口控制 IPC：悬停切可交互、外点/ESC 关窗（切回前台 app）、转正带主窗前台
  ipcMain.on('overlay:setInteractive', (_e, interactive: boolean) => setOverlayInteractive(interactive));
  ipcMain.on('overlay:close', () => onOverlayDismiss());
  ipcMain.on('overlay:promoted', () => onOverlayPromoted());

  setTriggerActive(true); // 拉起即开始监听；信任锚点/权限引导/开关都在 设置→偏好→界面
  started = true;
}

/** 回收桌面常驻层（before-quit / 关开关）——触发停 + 承载窗销毁 + IPC 摘除，与 startDesktopPresence 成对 */
export function disposeDesktopPresence(): void {
  if (!started) return;
  setTriggerActive(false);
  destroyOverlayWindow();
  ipcMain.removeAllListeners('overlay:setInteractive');
  ipcMain.removeAllListeners('overlay:close');
  ipcMain.removeAllListeners('overlay:promoted');
  restorePid = undefined;
  started = false;
}
