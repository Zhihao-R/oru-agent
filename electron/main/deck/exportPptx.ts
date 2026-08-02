/**
 * Deck PPT 导出（图片版，PRD §为什么 PPT 只做图片版）：每页渲染成一张满版图铺进 .pptx。
 * 复用联系表的逐页渲染（renderAllSlides）——一条 deck→逐页图路径，不另写第二套。
 * 文字是像素、不可编辑：HTML 排版降维到 PowerPoint 形状必然有损，图片版换取 100% 保真。
 */
import pptxgen from 'pptxgenjs';
import { renderAllSlides } from './contactSheet';
import { exportPath, writeExportAtomic, exportRenderConcurrency, INCHES_PER_PX } from './exportCommon';

export async function exportDeckToPptx(
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

  const wIn = canvas.width * INCHES_PER_PX;
  const hIn = canvas.height * INCHES_PER_PX;
  const pptx = new pptxgen();
  // 自定义版面 = deck 画布同比例，每页满版铺一张图、无边距
  pptx.defineLayout({ name: 'oru-deck', width: wIn, height: hIn });
  pptx.layout = 'oru-deck';
  for (const img of slideImages) {
    const slide = pptx.addSlide();
    slide.addImage({ data: `data:image/png;base64,${img}`, x: 0, y: 0, w: wIn, h: hIn });
  }

  const buf = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  const out = await exportPath(deckPath, 'pptx');
  await writeExportAtomic(out, buf);
  return out;
}
