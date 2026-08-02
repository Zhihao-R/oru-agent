/**
 * smoke(tsx)专用 electron 替身。
 *
 * 缘由：smoke 经纯 Node（tsx）跑，而 'electron' 这个 npm 包在 electron 运行时之外只导出二进制
 * 路径字符串、没有 app/BrowserWindow 等具名导出——任何主进程模块只要静态 `import { app } from
 * 'electron'`，在 tsx 下一加载就 `SyntaxError: does not provide an export named 'app'`，拖垮整条
 * smoke 链。vitest 侧靠逐文件 `vi.mock('electron')` 消化，smoke 侧此前靠"压根不 import app 模块"，
 * 后者被近期把 i18n/effectiveLang 拉进 agentTools 链的改动破了（见 loader.mjs 头注）。
 *
 * 本替身补齐 smoke 链上用到的具名导出，让模块加载得动。smoke 不验真实 electron 行为，故成员多为
 * 安全空操作；只有会被取真实类型的少数（app.getLocale 返回 locale 串、app.isPackaged 返回布尔）
 * 给真值，否则下游 `sys.toLowerCase()` / `join(app.getPath())` 会炸。
 */
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

// 递归安全桩：任意属性访问 / 调用 / new 都回另一个安全桩，方法链不炸（用于不取真实类型的成员）。
// ⚠ `then` 必须回 undefined：否则代理看着像 thenable，`await safe()` 会去调它的 then(resolve)
// 却永不 resolve → 顶层 await 永久挂起（Node 退出码 13）。回 undefined 让 await 立即解析为代理本身。
function safe() {
  const fn = () => safe();
  return new Proxy(fn, {
    get: (_t, p) => {
      if (p === 'then') return undefined;
      if (p === Symbol.toPrimitive) return () => '';
      return safe();
    },
    apply: () => safe(),
    construct: () => safe(),
  });
}

// app 的几个方法会被取真实类型（effectiveLang 读 locale、ensureBuiltin 读 isPackaged 等）——给真值。
const appBase = {
  isPackaged: false,
  getLocale: () => 'en-US',
  getPath: () => tmpdir(),
  getAppPath: () => process.cwd(),
  getName: () => 'oru',
  getVersion: () => '0.0.0-smoke',
  whenReady: () => Promise.resolve(),
  isReady: () => true,
};
export const app = new Proxy(appBase, { get: (t, p) => (p in t ? t[p] : safe()) });

export const BrowserWindow = safe();
export const dialog = safe();
export const shell = safe();
export const protocol = safe();
export const screen = safe();
export const globalShortcut = safe();
export const ipcMain = safe();
export const ipcRenderer = safe();
export const contextBridge = safe();
export const desktopCapturer = safe();
export const nativeImage = safe();
export const systemPreferences = safe();
export const webUtils = safe();
// backup/keyVault 静态 import { safeStorage }——smoke 不碰真实密钥，安全空操作即可
export const safeStorage = safe();

/**
 * powerMonitor：真 EventEmitter 假件——wakeRecovery 的 startWakeRecovery 要 `on('resume')` 注册
 * 监听并按 sleep-wake 协议在唤醒时主动推。smoke（纯 Node）里给它一个真 EventEmitter，既让模块
 * 加载得动，又能让 smoke 显式 `powerMonitor.emit('resume')` 真正触发唤醒逻辑（等价模拟系统唤醒）。
 */
export const powerMonitor = new EventEmitter();

export default {
  app,
  BrowserWindow,
  dialog,
  shell,
  protocol,
  screen,
  globalShortcut,
  ipcMain,
  ipcRenderer,
  contextBridge,
  desktopCapturer,
  nativeImage,
  systemPreferences,
  webUtils,
  safeStorage,
  powerMonitor,
};
