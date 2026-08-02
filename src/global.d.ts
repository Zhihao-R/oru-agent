export {};

import type { RoundSummary } from '@shared/debug/types';
import type { ScreenOverlayClick } from '@shared/types';

declare global {
  interface Window {
    __ORU__: {
      wsPort: number;
      platform: NodeJS.Platform;
      versions: {
        node: string;
        electron: string;
        chrome: string;
      };
      getPathForFile: (file: File) => string;
      /** 弹原生文件夹选择器，返回绝对路径；用户取消返回 null */
      pickDirectory: () => Promise<string | null>;
      /** Deck 预览 webview 的 preload 绝对路径（file://），由 main 通过 additionalArguments 注入 */
      deckPreviewPreloadPath: string;
      /** HTML 文件预览 webview 的 preload 绝对路径（file://）；复用 deckPreview.cjs，由 main 注入 */
      htmlPreviewPreloadPath: string;
    };
    oruDebug: {
      list: () => Promise<RoundSummary[]>;
      read: (dateKey: string, conversationId: string) => Promise<string>;
      openDir: () => Promise<void>;
      clearAll: () => Promise<void>;
    };
    /** 备份与还原桥（S07）：整体导出 / 换机还原，走 ipcMain；还原成功后主进程自动重启应用 */
    oruBackup: {
      /** 整体导出：选保存位置并打包。includeKeys=是否含明文密钥（默认不含） */
      export: (
        includeKeys: boolean,
      ) => Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }>;
      /** 换机还原：选备份包、二次确认后覆盖当前数据并重启。ok.path 为还原前兜底备份路径 */
      restore: () => Promise<
        { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
      >;
    };
    oruWindow: {
      setFullScreen: (value: boolean) => Promise<void>;
      /** 注册回调监听 OS 级全屏状态变化；返回 cleanup 函数 */
      onFullScreenChanged: (cb: (isFullScreen: boolean) => void) => () => void;
    };
    /** 唤起对话承载窗的桥（仅独立浮层渲染窗存在；主窗下为 undefined） */
    oruOverlay?: {
      /** 主进程窗外 ⌥ 点载荷；返回 cleanup 摘监听 */
      onClick: (cb: (payload: ScreenOverlayClick) => void) => () => void;
      /** 悬停浮层切可交互 / 离开切穿透 */
      setInteractive: (interactive: boolean) => void;
      /** 外点/ESC：请主进程隐藏承载窗并把前台还给原 app */
      close: () => void;
      /** 转正（↗）：请主进程把 Oru 主窗带到前台承接正式对话 */
      promoted: () => void;
    };
  }
}
