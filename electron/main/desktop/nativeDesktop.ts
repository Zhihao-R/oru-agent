/**
 * 唤起对话的 macOS native 能力接口（技术设计 §11「一个 native 模块三合一」的 hit-test + 聚焦两块；
 * 第三块 uiohook 全局触发是现成 npm 包，见 trigger.ts）。
 *
 * 两个能力 Electron 都没有现成 API：
 * - windowOwnerAtPoint：`CGWindowListCopyWindowInfo` 做真 window-at-point（§8 / §12 风险 10）。
 *   active-win 只给 frontmost，主窗被遮挡时判错 → 「点了没反应」，必须靠它。
 * - makeKeyNonactivating：把承载窗的 NSPanel 设 nonactivating + makeKeyAndOrderFront（§7 / §12 风险 3），
 *   实现「弹出即打字、不打断背后」。须在 Electron 进程内拿 BrowserWindow 的 NSWindow 句柄——
 *   子进程 helper 碰不到进程内 NSWindow，故只能 in-process addon（第一性：聚焦需求倒逼 addon 路线）。
 *
 * addon 未构建时（开发机没跑过 native build）loadNativeDesktop 返回 null——上层据此降级：
 * 无 hit-test 则退回 active-win 前台名（分流会偏保守），无聚焦则浮层弹出但需点一下输入框。
 * 让「没 addon 也能跑」是为了 dev 不被 native 工具链阻断，不是生产形态。
 */
import { app } from 'electron';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** window-at-point 命中窗的归属——分流裁决（命中 Oru 自己 → 走窗内老路）与前台 app 名来源 */
export type WindowOwner = { pid: number; app: string };

export interface NativeDesktop {
  /** 该 DIP 全局点命中的最上层普通窗的归属；点在桌面/无窗处返回 null */
  windowOwnerAtPoint(x: number, y: number): WindowOwner | null;
  /**
   * 让承载窗拿键盘焦点（弹出即打字）。handle = BrowserWindow.getNativeWindowHandle()（NSView*）。
   * 实测：Electron type:'panel' 非真 NSPanel，拿键盘焦点必伴 Oru 激活（menu bar 切 Oru，主窗不前置，
   * 背后 app 窗仍可见——Spotlight 形态，用户已定）。关浮层时用 activateApp 把前台还回去。
   */
  makeKeyNonactivating(handle: Buffer): void;
  /** 把前台 / 键盘焦点还给指定 pid 的 app（关浮层后切回用户原来在用的那个） */
  activateApp(pid: number): void;
}

let cached: NativeDesktop | null | undefined;

/**
 * 加载 native addon（懒加载 + 记忆结果）。仅 macOS；加载失败（未构建 / 非 mac）一律返回 null，
 * 不抛——native 缺席是降级路径不是错误。require 用动态 createRequire 避开 vite 静态打包它。
 */
export function loadNativeDesktop(): NativeDesktop | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'darwin') return cached;
  try {
    // createRequire：运行时按绝对路径 require native .node，不进 bundle（vite 不静态分析它的参数）
    const req = createRequire(import.meta.url);
    const addon = req(addonPath()) as NativeDesktop;
    // 三个导出都验（ABI/版本错位致导出残缺时整体降级，不留半残接口）
    if (
      typeof addon.windowOwnerAtPoint === 'function' &&
      typeof addon.makeKeyNonactivating === 'function' &&
      typeof addon.activateApp === 'function'
    ) {
      cached = addon;
    }
  } catch (e) {
    console.warn('[desktop.native] addon 未加载（降级）:', e instanceof Error ? e.message : e);
  }
  return cached;
}

/**
 * native .node 的绝对路径——刻意不放 out/main：electron-vite 每次 build/dev 都重建 out/，会把它冲掉。
 * - dev：从 addon 自己的 build/Release（`npm run build:native` 产物，electron-vite 不碰）解析，
 *   从 out/main/index.js 上溯两级到仓库根再进 electron/native/...。
 * - prod（已打包）：electron-builder 经 extraResources 拷到 resources/，走 process.resourcesPath。
 */
function addonPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'desktop_native.node');
  const here = dirname(fileURLToPath(import.meta.url)); // out/main
  return join(here, '../../electron/native/desktop/build/Release/desktop_native.node');
}
