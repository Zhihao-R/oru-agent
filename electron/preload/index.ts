import { contextBridge, ipcRenderer, webUtils } from 'electron';

const portArg = process.argv.find((a) => a.startsWith('--oru-ws-port='));
const wsPort = portArg ? Number(portArg.split('=')[1]) : 0;

// Deck 模块（v1）：webview preload 路径由 main 进程通过 additionalArguments 传过来；
// 加 file:// 前缀让 <webview preload=...> 能直接用
const deckPreviewArg = process.argv.find((a) => a.startsWith('--oru-deck-preview-preload='));
const deckPreviewPreloadPath = deckPreviewArg
  ? `file://${deckPreviewArg.split('=')[1]}`
  : '';

// HTML 文件预览 webview 的 preload 路径——复用同一份 deckPreview.cjs（main 侧传同一路径），
// 解析方式与 deck 对齐：加 file:// 前缀让 <webview preload=...> 直接可用
const htmlPreviewArg = process.argv.find((a) => a.startsWith('--oru-html-preview-preload='));
const htmlPreviewPreloadPath = htmlPreviewArg
  ? `file://${htmlPreviewArg.split('=')[1]}`
  : '';

contextBridge.exposeInMainWorld('__ORU__', {
  wsPort,
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  // Electron 32+ 移除了 File.prototype.path；renderer 必须经此拿绝对路径
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  // 原生文件夹选择器（添加项目用）；取消返回 null
  pickDirectory: () =>
    ipcRenderer.invoke('dialog:pickDirectory') as Promise<string | null>,
  /** Deck 预览 webview 的 preload 绝对路径（file:// 协议）；空串表示未配置 */
  deckPreviewPreloadPath,
  /** HTML 文件预览 webview 的 preload 绝对路径（file://）；复用 deckPreview.cjs，空串表示未配置 */
  htmlPreviewPreloadPath,
});

/**
 * 调试模块 IPC 桥（详 docs/tech/2026-05-10-debug-module-tech-design.md §4.6）
 *
 * debug 数据是历史快照，不进 WS；renderer 通过 window.oruDebug 调主进程。
 */
contextBridge.exposeInMainWorld('oruDebug', {
  list: () => ipcRenderer.invoke('debug:list'),
  read: (dateKey: string, conversationId: string) =>
    ipcRenderer.invoke('debug:read', dateKey, conversationId),
  openDir: () => ipcRenderer.invoke('debug:openDir'),
  clearAll: () => ipcRenderer.invoke('debug:clearAll'),
});

/**
 * 唤起对话承载窗的桥（仅独立浮层窗用；主窗加载同份 preload 但不调）：
 * - onClick：主进程 'overlay:click' 推来的窗外 ⌥ 点载荷 → 渲染端组 AsideClick 喂 overlayMachine
 * - setInteractive：悬停浮层面板时切可交互、离开切穿透（穿透与输入的矛盾，§7）
 * - close：外点/ESC/转正后请主进程隐藏承载窗
 */
contextBridge.exposeInMainWorld('oruOverlay', {
  onClick: (cb: (payload: unknown) => void) => {
    const handler = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('overlay:click', handler);
    return () => ipcRenderer.removeListener('overlay:click', handler);
  },
  setInteractive: (interactive: boolean) => ipcRenderer.send('overlay:setInteractive', interactive),
  close: () => ipcRenderer.send('overlay:close'),
  promoted: () => ipcRenderer.send('overlay:promoted'),
});

/**
 * 窗口控制：deck 模块的 OS 全屏切换走这里，cleanup 函数让 renderer 取消监听
 */
contextBridge.exposeInMainWorld('oruWindow', {
  setFullScreen: (value: boolean) =>
    ipcRenderer.invoke('window:setFullScreen', value) as Promise<void>,
  onFullScreenChanged: (cb: (isFullScreen: boolean) => void) => {
    const handler = (_e: unknown, v: boolean) => cb(v);
    ipcRenderer.on('window:fullScreenChanged', handler);
    return () => ipcRenderer.removeListener('window:fullScreenChanged', handler);
  },
});

/**
 * 备份与还原桥（S07）：整体导出 / 换机还原是 app 级文件操作（要原生对话框、要重启），
 * 不进 WS 数据通道，走 ipcMain。还原成功后主进程会自动重启应用。
 */
contextBridge.exposeInMainWorld('oruBackup', {
  export: (includeKeys: boolean) =>
    ipcRenderer.invoke('backup:export', includeKeys) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
  restore: () =>
    ipcRenderer.invoke('backup:restore') as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
});

// Window 接口的类型声明放在 src/global.d.ts 单源——renderer 需要的类型在那里。
// preload 里**不再重复 declare global**，避免两边漂移。
