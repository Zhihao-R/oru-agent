/**
 * 唤起对话整屏截图的坐标数学（技术设计 §4，多屏对齐的根）——纯函数逐项验证：
 * - bitmapPointFromGlobal：DIP 全局点 → 位图物理像素 = (gp − origin) × scaleFactor（含 @2x / 偏移屏）
 * - downsamplePlan：长边超阈才缩、点击点按同比例换算、scale=1 时原样
 * captureScreenAtPoint 触碰 Electron desktopCapturer/screen，留给真机 playtest（PoC 已坐实）。
 */
import { describe, expect, it } from 'vitest';
import {
  bitmapPointFromGlobal,
  downsamplePlan,
  DOWNSAMPLE_LONG_EDGE,
} from '../../electron/main/desktop/screenCapture';

describe('bitmapPointFromGlobal', () => {
  it('@1x 主屏（原点 0,0）：位图坐标 = 全局坐标', () => {
    expect(bitmapPointFromGlobal({ x: 300, y: 200 }, { x: 0, y: 0 }, 1)).toEqual({ x: 300, y: 200 });
  });

  it('@2x 主屏：物理像素 = 逻辑 × scaleFactor', () => {
    expect(bitmapPointFromGlobal({ x: 300, y: 200 }, { x: 0, y: 0 }, 2)).toEqual({ x: 600, y: 400 });
  });

  it('偏移的第二屏（bounds.origin ≠ 0）：先减原点再乘 scaleFactor', () => {
    // 第二屏 bounds 起点 (1440,0)，@2x；点在屏内 (1500,100)
    expect(bitmapPointFromGlobal({ x: 1500, y: 100 }, { x: 1440, y: 0 }, 2)).toEqual({
      x: 120,
      y: 200,
    });
  });
});

describe('downsamplePlan', () => {
  it('长边超阈：按 longEdge/long 缩放，点击点同比例换算', () => {
    // 5120×2880（@2x 的 2560×1440 屏）→ 长边 5120 > 1568，scale = 1568/5120 = 0.30625
    const plan = downsamplePlan({ width: 5120, height: 2880 }, { x: 1000, y: 500 });
    expect(plan.scale).toBeCloseTo(1568 / 5120, 6);
    expect(plan.width).toBe(1568); // 长边正好压到 longEdge
    expect(plan.height).toBe(Math.round(2880 * (1568 / 5120)));
    expect(plan.click).toEqual({
      x: Math.round(1000 * (1568 / 5120)),
      y: Math.round(500 * (1568 / 5120)),
    });
  });

  it('长边不超阈（小屏）：scale=1、尺寸与点击点原样', () => {
    const plan = downsamplePlan({ width: 1280, height: 800 }, { x: 640, y: 400 });
    expect(plan.scale).toBe(1);
    expect(plan.width).toBe(1280);
    expect(plan.height).toBe(800);
    expect(plan.click).toEqual({ x: 640, y: 400 });
  });

  it('长边恰等于阈值：不缩（> 才缩）', () => {
    const plan = downsamplePlan({ width: DOWNSAMPLE_LONG_EDGE, height: 900 }, { x: 10, y: 10 });
    expect(plan.scale).toBe(1);
  });
});
