/**
 * aside.capture：主窗口整窗截图（技术方案 §4）。
 *
 * capturePage 返回的是物理像素（Retina 下 2x，跨机器尺寸不定）——必须 resize 归一回
 * 逻辑 viewport（htmlRenderer.ts renderHtmlToImage 同口径），渲染进程才能按逻辑坐标
 * 在图上画点击标记。
 */
import { getMainWindow } from '../../window/mainWindowRef';

/** 截主窗口当前画面，归一为逻辑像素后返回 PNG base64（不带 data: 前缀） */
export async function captureMainWindowScreenshot(): Promise<string> {
  const win = getMainWindow();
  if (!win) throw new Error('主窗口不存在，无法截图');
  const raw = await win.webContents.capturePage();
  if (raw.isEmpty()) throw new Error('截图为空');
  const [width, height] = win.getContentSize(); // 逻辑像素
  return raw.resize({ width, height }).toPNG().toString('base64');
}
