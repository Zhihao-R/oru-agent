/**
 * PDF 文本抽取（S34 · G26，锚 conversation-flow.html#Ingest「PDF 等大文件分页读」）。
 *
 * read_file 原本只认文本，PDF 读进来是二进制乱码。这里用 pdfjs 逐页抽文字，页间插页标记，产出
 * 纯文本后交回 read_file 走既有大文件行分页闸（offset 续读）——PDF 与普通大文本共用同一套分页，
 * 不为 PDF 另造一套 offset=页码 的语义（保持「同一个 read_file」一致性）。
 *
 * pdfjs 动态 import：只有真读 PDF 时才加载这坨大依赖，非 PDF 路径与不碰 PDF 的单测都不受牵连
 * （同 imageDecoder 动态 import electron 的处理）。Node 下 pdfjs 走内置 fake worker，无需 workerSrc。
 */
import { readFile as readFileBytes } from 'node:fs/promises';

/** 抽取整份 PDF 为带页标记的纯文本。解析失败（加密 / 损坏 / 非 PDF）抛错，由调用方翻成 isError。 */
export async function extractPdfText(path: string): Promise<string> {
  const bytes = await readFileBytes(path);
  // legacy 构建面向 Node/非 DOM 环境；isEvalSupported=false 关掉 eval 提速路径（沙箱更稳）。
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  try {
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // pdfjs 文本项无天然行概念：用 hasEOL 还原换行，其余项以空格相连。
      const text = content.items
        .map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .trimEnd();
      pages.push(`--- 第 ${p} 页 / 共 ${doc.numPages} 页 ---\n${text}`);
    }
    return pages.join('\n\n');
  } finally {
    // 页级操作可能对损坏 PDF 抛错——destroy 必须在异常路径也跑，否则泄漏 pdfjs worker 引用。
    await doc.destroy();
  }
}
