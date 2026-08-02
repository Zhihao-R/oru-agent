/**
 * 唤起对话（系统级）的整屏截图与坐标归一（技术设计 §4）——多屏对齐的根，易塌。
 *
 * 与窗口内 `ws/aside/capture.ts` 的区别：那条截主窗、归一回逻辑像素让渲染端按逻辑坐标画标记；
 * 这条截「点击所在 display」整屏，下采样压体量，并把点击点换算进下采样后的位图坐标系——
 * 渲染端（独立浮层窗）拿到的截图与点击点同系，复用 `markClickOnScreenshot` 画聚光圈，与 deck 路径同构
 * （所以 §5 的「主进程后期合成」并非必需：圈在渲染端离屏 canvas 上画，不碰活桌面）。
 *
 * 坐标系结论（PoC 2026-06-21 实测，§12 风险 2）：uiohook 全局坐标 = DIP / 左上原点，与
 * Electron `screen` 同系——无需翻转 Y / 除 scaleFactor，直接喂 getDisplayNearestPoint。
 * 帧尺寸 = size × scaleFactor、`source.display_id` 显式匹配均坐实。多屏 / 混合 DPI 未覆盖（无外接屏）。
 */
import { desktopCapturer, screen } from 'electron';

/** 下采样目标长边——评点视觉模型可接受量级（PoC 实测此值下整链 ~320ms，§12 风险 4） */
export const DOWNSAMPLE_LONG_EDGE = 1568;

/** DIP 全局点（左上原点） */
export type GlobalPoint = { x: number; y: number };

/**
 * DIP 全局点 → 该 display 位图的物理像素坐标：(gp − bounds.origin) × scaleFactor。
 * 纯函数（§4 第一步对齐最易塌，单独可测）。
 */
export function bitmapPointFromGlobal(
  gp: GlobalPoint,
  bounds: { x: number; y: number },
  scaleFactor: number,
): { x: number; y: number } {
  return {
    x: Math.round((gp.x - bounds.x) * scaleFactor),
    y: Math.round((gp.y - bounds.y) * scaleFactor),
  };
}

/**
 * 下采样方案：长边超过 longEdge 才缩；点击点按同一比例换算进下采样后坐标系。
 * scale=1（无需下采样）时点击点原样。纯函数（体量压缩步，与 DPR 归一不同目标，§4）。
 */
export function downsamplePlan(
  frame: { width: number; height: number },
  clickBmp: { x: number; y: number },
  longEdge: number = DOWNSAMPLE_LONG_EDGE,
): { width: number; height: number; scale: number; click: { x: number; y: number } } {
  const long = Math.max(frame.width, frame.height);
  const scale = long > longEdge ? longEdge / long : 1;
  return {
    width: Math.max(1, Math.round(frame.width * scale)),
    height: Math.max(1, Math.round(frame.height * scale)),
    scale,
    click: { x: Math.round(clickBmp.x * scale), y: Math.round(clickBmp.y * scale) },
  };
}

/** 一次整屏截图的产物——交独立浮层窗复用 markClickOnScreenshot 画聚光圈、发 aside.comment */
export type ScreenShot = {
  /** 下采样后整屏 PNG base64（不带 data: 前缀） */
  base64: string;
  /** 点击点在该截图坐标系内的位置（聚光圈圆心） */
  click: { x: number; y: number };
  /** 命中的 display id + 逻辑 bounds——承载窗按它定位覆盖整块屏 */
  display: { id: number; bounds: { x: number; y: number; width: number; height: number } };
};

/**
 * 截「globalPoint 所在 display」整屏 → 下采样 → 算点击点位图坐标。
 * 失败（屏幕录制权限未授 → 源列表无匹配，或抓帧异常）返回 null：上游降级为无图评点（§4 同哲学，
 * 链路失败不阻断浮层）。截哪块屏按 `display_id` 显式匹配，绝不用数组下标（否则截错屏，§4）。
 */
export async function captureScreenAtPoint(gp: GlobalPoint): Promise<ScreenShot | null> {
  const display = screen.getDisplayNearestPoint(gp);
  const physW = Math.round(display.size.width * display.scaleFactor);
  const physH = Math.round(display.size.height * display.scaleFactor);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: physW, height: physH },
  });
  const match = sources.find((s) => s.display_id === String(display.id));
  if (!match || match.thumbnail.isEmpty()) return null;

  const frame = match.thumbnail;
  const fsize = frame.getSize();
  const clickBmp = bitmapPointFromGlobal(gp, display.bounds, display.scaleFactor);
  const plan = downsamplePlan(fsize, clickBmp);
  const out = plan.scale < 1 ? frame.resize({ width: plan.width, height: plan.height }) : frame;
  return {
    base64: out.toPNG().toString('base64'),
    click: plan.click,
    display: { id: display.id, bounds: display.bounds },
  };
}
