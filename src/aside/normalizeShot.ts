/**
 * 截图归一：capturePage 产物是物理像素（按 dpr 放大、跨机器尺寸不定），
 * 缩回逻辑尺寸后"点击坐标即截图坐标"，下游画标记点不用碰 dpr——
 * 与主进程 aside.capture 的归一口径一致（electron/main/ws/aside/capture.ts）。
 *
 * 渲染进程拿不到 NativeImage.resize（webview.capturePage 返回的对象只暴露 toPNG/isEmpty），
 * 用 canvas 缩放。
 */

/** 物理像素 PNG → 逻辑尺寸 PNG base64（不带 data: 前缀） */
export async function normalizePngToLogical(
  png: Uint8Array,
  logicalWidth: number,
  logicalHeight: number,
): Promise<string> {
  // toPNG 产物的后备永远是普通 ArrayBuffer，不会是 SharedArrayBuffer——收窄给 BlobPart
  const bitmap = await createImageBitmap(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(logicalWidth));
    canvas.height = Math.max(1, Math.round(logicalHeight));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d 上下文不可用');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  } finally {
    bitmap.close();
  }
}
