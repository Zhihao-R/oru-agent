import { wsClient } from '@/lib/ws';
import type { DocExportResultEvent } from '@shared/protocol';
import { renderMarkdownExportHtml, isExportableMarkdown } from '@/lib/markdownExport';

/**
 * 导出当前编辑器中打开的 md 文档（技术方案 §六.1）。导出 HTML 的真相源活在前端：这里用共享
 * <MarkdownDoc> + renderToStaticMarkup 渲染完整 HTML，再发 doc.export 给主进程落地（HTML 内联资源 /
 * PDF 离屏 printToPDF）。完成后主进程在访达选中文件（showItemInFolder）。
 *
 * paperMode 仅 PDF 有意义：HTML 出口恒书本风。空文档前置拦截、不发请求（PRD 护栏）。
 */
export type ExportDocResult = {
  ok: boolean;
  path?: string;
  cancelled?: boolean;
  message?: string;
  /** HTML 出口未能内联的本地图片（缺图不阻断导出，UI 据此给提示）。 */
  missing?: string[];
};

// PDF 长文离屏渲染可能慢；HTML 长文 + 大量内联图也可能久。给足超时，避免请求超时报"失败"但文件其实已写出。
const EXPORT_TIMEOUT_MS = 600_000;

export async function exportDoc(opts: {
  projectId: string;
  path: string; // 项目相对文档 path
  content: string;
  format: 'html' | 'pdf';
  paperMode?: boolean;
}): Promise<ExportDocResult> {
  if (!isExportableMarkdown(opts.content)) {
    return { ok: false, message: '文档为空，没有可导出的内容' };
  }
  const paperMode = opts.format === 'pdf' && !!opts.paperMode;
  const html = renderMarkdownExportHtml(opts.content, {
    paperMode,
    docIdentity: { projectId: opts.projectId, docPath: opts.path },
    title: docTitle(opts.path),
  });
  const res = await wsClient.request<DocExportResultEvent>(
    {
      type: 'doc.export',
      projectId: opts.projectId,
      path: opts.path,
      html,
      format: opts.format,
      paperMode, // 已折叠：仅 PDF 且开关开时为 true，其余恒 false（主进程 !!req.paperMode 兜底）
    },
    EXPORT_TIMEOUT_MS,
  );
  if (res.type === 'doc.export.result') {
    return {
      ok: res.ok,
      path: res.path,
      cancelled: res.cancelled,
      message: res.message,
      missing: res.missing,
    };
  }
  return { ok: false, message: '导出失败' };
}

/** 取消进行中的导出（按 projectId+path）。仅通知后端中断，进行中的 exportDoc 走结果 cancelled。 */
export async function cancelDocExport(projectId: string, path: string): Promise<void> {
  await wsClient.request({ type: 'doc.exportCancel', projectId, path });
}

/** 文件名去扩展名作导出物标题（'笔记/报告.md' → '报告'）。 */
function docTitle(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
