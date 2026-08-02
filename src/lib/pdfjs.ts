/**
 * 渲染进程 pdfjs 单一初始化点（PDF tech design §三）。
 *
 * pdfjs 首次在渲染进程用（主进程 agentTools/pdfText.ts 走的是 Node legacy build + fake worker，互不干扰）。
 * worker 必须配：`?url` 让 electron-vite renderer 构建把 pdf.worker.mjs 作为静态资源产出并给出可加载 URL，
 * 开发（localhost）/打包（file://）都成立。只此一处赋值 GlobalWorkerOptions，别在组件里散落。
 *
 * 构建验证项：`npm run build` 后确认 out/renderer 里 worker 资源存在且可加载——漏了会静默回退主线程、大文件即卡。
 */
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
