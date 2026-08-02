import { pdfjs } from '@/lib/pdfjs';
import type { PDFDocumentProxy, TextContent } from 'pdfjs-dist/types/src/display/api';

/** 加载失败的两类（PRD §错误）：受密码保护 / 文件损坏。其余解析异常都并入 corrupt。 */
export type PdfLoadError = 'encrypted' | 'corrupt';

/**
 * 拼 oru-doc-pdf:// URL——两段各整段 encode（含 ref 内的 `/`），与主进程 parseDocPdfUrl 口径一致。
 * ref = 项目相对 path；projectId 查项目根在主进程侧完成，渲染端不碰绝对布局。
 */
export function buildPdfUrl(projectId: string, ref: string): string {
  return `oru-doc-pdf://local/${encodeURIComponent(projectId)}/${encodeURIComponent(ref)}`;
}

/**
 * 把 getDocument 的 reject reason 归类。pdfjs 未导出 PasswordException 类，按 err.name 判更稳
 * （不依赖类引用，跨构建可靠）。密码 → encrypted；InvalidPDF/其余 → corrupt。
 */
export function classifyLoadError(err: unknown): PdfLoadError {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'PasswordException') return 'encrypted';
  return 'corrupt';
}

/** 加载 PDF 文档。成功返回 PDFDocumentProxy；失败 throw PdfLoadError（已归类）。 */
export async function loadPdf(url: string): Promise<PDFDocumentProxy> {
  try {
    return await pdfjs.getDocument({ url }).promise;
  } catch (err) {
    throw classifyLoadError(err);
  }
}

/** 一页拼接后的纯文本（items 顺序 join）——搜索匹配与高亮定位共用同一个字符串口径。 */
export function pageText(tc: TextContent): string {
  return tc.items.map((it) => ('str' in it ? it.str : '')).join('');
}

/** 在页文本里找 query 的全部命中起始偏移（大小写不敏感）。query 为空返回空。 */
export function findOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: number[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}
