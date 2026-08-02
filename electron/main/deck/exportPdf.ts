/**
 * Deck PDF 导出（图片版）：每页离屏渲染成图，逐页满版铺进 PDF。
 *
 * 为什么是图片版而非矢量 printToPDF（实测决策，2026-06-16）：矢量版有两个硬伤——
 * (1) 30 页径向渐变 + 网格底纹的矢量运算让查看反复栅格化、又大又卡；
 * (2) 打印媒体/绘制时序下部分页内容（如逐项卡片）丢失。改走和联系表 / PPT 同一条
 * renderAllSlides 逐页渲染路径（所见即所得、内容完整），再 JPEG 直嵌 PDF——扁平位图
 * 查看秒开、体积可控。代价：文字变栅格、不可选中，与 PPT 图片版同款取舍。
 *
 * 与 PPT 的分工：PPT 铺图进 .pptx（pptxgenjs），PDF 铺图进 .pdf（pdf-lib）；同一条
 * deck→逐页图路径喂两个格式专用库，不另写第二套渲染。
 */
import { nativeImage } from 'electron';
import { PDFDocument } from 'pdf-lib';
import { renderAllSlides } from './contactSheet';
import { exportPath, writeExportAtomic, exportRenderConcurrency, INCHES_PER_PX } from './exportCommon';

/** JPEG 质量（0-100）：位图换体积。88 下渐变不明显带状、文字边缘轻微振铃可接受（已选 JPEG over PNG）。 */
const JPEG_QUALITY = 88;
/** PDF 排版单位是「点」（1pt = 1/72 in）；设计 px @96dpi → 点 = px × 72/96。 */
const POINTS_PER_PX = INCHES_PER_PX * 72;

export async function exportDeckToPdf(
  deckPath: string,
  signal?: AbortSignal,
  opts?: { deviceScaleFactor?: number; onProgress?: (done: number, total: number) => void },
): Promise<string> {
  const { slideImages, canvas } = await renderAllSlides(deckPath, signal, {
    ...opts,
    concurrency: exportRenderConcurrency(),
  });
  if (slideImages.length === 0) {
    throw new Error('deck 无可导出页');
  }

  // 页面尺寸 = 画布同比例（点）；每页一张满版图、无边距，宽高比与画布一致。
  const wPt = canvas.width * POINTS_PER_PX;
  const hPt = canvas.height * POINTS_PER_PX;
  const pdf = await PDFDocument.create();
  for (const pngBase64 of slideImages) {
    // 逐页 PNG 重编码成 JPEG，pdf-lib 以 DCTDecode 直嵌字节（不再过 Chromium 打印、不被重编码）。
    const jpeg = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64')).toJPEG(JPEG_QUALITY);
    const img = await pdf.embedJpg(jpeg);
    const page = pdf.addPage([wPt, hPt]);
    page.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
  }

  const data = Buffer.from(await pdf.save());
  const out = await exportPath(deckPath, 'pdf');
  await writeExportAtomic(out, data);
  return out;
}
