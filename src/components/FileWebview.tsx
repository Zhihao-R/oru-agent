import type { Ref } from 'react';
import { fileUrl } from '@/lib/fileUrl';

/** Electron `<webview>` 的最小子集——只用到 reload()。不 import 'electron' 类型，原因见 PreviewPane 注释（Vite 会试图 bundle main API 致白屏）。 */
export type ReloadableWebview = HTMLElement & { reload(): void };

/**
 * 把本地文件铺满一个 webview 视口——文件树「按类型打开」的统一渲染原语（HtmlViewer / 图片标签
 * 共用，"文件树打开 = 在 webview 视口里渲染该文件"）。主窗口 `<img>` / 主 DOM 受 webSecurity 拦不能
 * file://，但 `<webview>` 是独立 guest，能直接加载 file://。
 *
 * `display: inline-flex` 是 Electron `<webview>` 的非显然约定：默认 embed intrinsic 300×150，
 * display:block 时内部 webContents viewport 高度不跟随 CSS height，必须 inline-flex 才跑满
 * （同 PreviewPane 的 plain 分支）。这条载重知识收口在这里一处，调用方只传绝对路径。
 *
 * partition 固定 `persist:html-viewer`：与 deck 预览的 `persist:deck-preview` 隔离——单 html / 图片
 * 是只读看一眼，session 不与 deck 共享。
 *
 * preload 是可选 prop，由消费者决定挂不挂：FileWebview 是中立渲染原语，不该自己决定要不要编辑能力。
 * HtmlViewer 传入 deckPreview.cjs（为 HTML 页注入「右键改字」绑定）；图片标签不传——图片不背
 * 编辑基础设施。缺省时不设 preload 属性（空字符串等价不加载，但省略更诚实）。
 */
export function FileWebview({
  absPath,
  webviewRef,
  preloadPath,
}: {
  absPath: string;
  webviewRef?: Ref<ReloadableWebview>;
  preloadPath?: string;
}): JSX.Element {
  return (
    <webview
      ref={webviewRef}
      src={fileUrl(absPath)}
      {...(preloadPath ? { preload: preloadPath } : {})}
      partition="persist:html-viewer"
      style={{ width: '100%', height: '100%', display: 'inline-flex' }}
    />
  );
}
