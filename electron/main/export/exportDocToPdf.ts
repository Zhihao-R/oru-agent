/**
 * Markdown 导出 —— 矢量 PDF 出口（技术方案 §五）。
 *
 * 与 deck 的有意分歧：deck PDF 走图片版（deck/exportPdf.ts 记录了 printToPDF 在复杂视觉布局下的两个
 * 实测硬伤——重渐变/网格底纹矢量运算又大又卡、打印媒体时序丢内容）。md 是纯文字流，两个硬伤都不成立，
 * 于是拿回 printToPDF 的全部好处：矢量、文字可选可搜、体积小、真分页。第一性上由产物形态推出分栈。
 *
 * 路径：注入内联了字体的 katex <style>（数学字体；图走 oru-doc-img:// 协议、离屏窗口直接加载，无需内联）
 *   → withOffscreenPage 起离屏窗口加载 inline HTML（baseDir=源文档目录）→ page.webContents.printToPDF
 *   → 原子落盘到源文档同目录、同名换后缀、撞名加序号。导出全程只读源 md。
 *
 * 物理页几何（A4 / 页边距 / 页码）归这里（与 pageSize 同处），由 paperMode 选择（见 pdfPrintOptions）：
 * 渲染端 CSS 只管观感（book/paper 的衬线/两端对齐/分页行为）。
 */
import type { PrintToPDFOptions } from 'electron';
import { tmpdir } from 'node:os';
import { basename, dirname, extname } from 'node:path';
import { withOffscreenPage } from '../render/htmlRenderer';
import { firstFreePath, writeExportAtomic } from '../deck/exportCommon';
import { injectKatexInto } from './katexAssets';

// 纸张版页码页脚：Chromium 页脚默认 font-size:0，必须显式给字号才可见；居中页码、低调灰。
const PAGE_FOOTER =
  '<div style="font-size:9px;width:100%;text-align:center;color:#888;"><span class="pageNumber"></span></div>';
// 与 displayHeaderFooter 搭配时需给 headerTemplate，否则 Chromium 会塞默认日期页眉。
const EMPTY_HEADER = '<div></div>';

/**
 * 按纸张版开关产出 printToPDF 选项。两版都 A4 真分页 + 打印底色（代码块/引用底色要打出来）；
 * 纸张版页边距更规整、带页码页脚，书本版页边距较紧、无页脚。margins 单位为英寸。
 *
 * 有意裁决（与技术文档 §六「主进程不需要 paperMode」那条相左）：物理页几何（A4 + 页边距 + 页码）全收在
 * 这里、由 paperMode 驱动——pageSize 已在主进程，把同维度的 margins 拆去 CSS @page 是把「一页的定义」劈成
 * 两处；且 Electron printToPDF 对 @page margin 的支持随 Chromium 版本飘忽，用 margins 参数才是确定行为。
 * CSS 只管观感（book/paper 的衬线/两端对齐/分页行为）。
 */
export function pdfPrintOptions(paperMode: boolean): PrintToPDFOptions {
  return {
    pageSize: 'A4',
    printBackground: true,
    margins: paperMode
      ? { marginType: 'custom', top: 1, bottom: 1, left: 1, right: 1 }
      : { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
    displayHeaderFooter: paperMode,
    ...(paperMode ? { headerTemplate: EMPTY_HEADER, footerTemplate: PAGE_FOOTER } : {}),
  };
}

export async function exportDocToPdf(
  docAbsPath: string,
  html: string,
  opts: { paperMode: boolean; signal?: AbortSignal },
): Promise<{ path: string }> {
  const withKatex = await injectKatexInto(html);
  // baseDir 用系统临时目录而非源文档目录：katex 已内联 data URI、图走 oru-doc-img:// 协议（绝对、与
  // baseDir 无关），离屏渲染没有任何相对资源需要从文档目录解析——故不必把 .render-tmp 临时文件写进
  // 用户项目目录（避免污染、避免惊动文件树）。
  return withOffscreenPage(
    { source: { kind: 'inline', html: withKatex, baseDir: tmpdir() }, signal: opts.signal },
    async (page) => {
      const data = await page.guard(
        page.webContents.printToPDF(pdfPrintOptions(opts.paperMode)),
        'PDF 生成超时',
      );
      const out = await firstFreePath(dirname(docAbsPath), basename(docAbsPath, extname(docAbsPath)), 'pdf');
      await writeExportAtomic(out, data);
      return { path: out };
    },
  );
}
