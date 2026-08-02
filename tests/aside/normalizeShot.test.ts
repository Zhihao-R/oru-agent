/** @vitest-environment jsdom */
/**
 * 截图归一（src/aside/normalizeShot.ts）：高 dpr 模拟——capturePage 物理产物 2x，
 * 归一目标必须是逻辑尺寸（画布 = 逻辑宽高、整图 drawImage 缩放），这是
 * "点击坐标即截图坐标、标记点不偏"的前提（与 deckClick 坐标测试合起来锁住该不变量）。
 *
 * jsdom 没有 createImageBitmap / canvas 2d，按调用面打桩并断言归一参数。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePngToLogical } from '@/aside/normalizeShot';

// 物理 2x（dpr=2 机器上 200×120 的 capturePage 产物），逻辑 100×60
const LOGICAL = { width: 100, height: 60 };
// 每个用例独立 bitmap——close 计数不跨用例串
function makeBitmap() {
  return {
    width: LOGICAL.width * 2,
    height: LOGICAL.height * 2,
    close: vi.fn(),
  } satisfies Pick<ImageBitmap, 'width' | 'height' | 'close'>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('normalizePngToLogical', () => {
  it('物理 2x → 画布取逻辑尺寸、整图缩放绘入、产出 base64、bitmap 释放', async () => {
    const bitmap = makeBitmap();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));

    const drawCalls: unknown[][] = [];
    let canvasEl: HTMLCanvasElement | null = null;
    const ctxStub = {
      drawImage: (...a: unknown[]) => {
        drawCalls.push(a);
      },
    } satisfies Pick<CanvasRenderingContext2D, 'drawImage'>;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      canvasEl = this;
      return ctxStub as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,QUJD');

    const base64 = await normalizePngToLogical(new Uint8Array([1, 2, 3]), LOGICAL.width, LOGICAL.height);

    // 画布即归一目标：逻辑尺寸，不是物理尺寸
    expect(canvasEl!.width).toBe(LOGICAL.width);
    expect(canvasEl!.height).toBe(LOGICAL.height);
    // 整图缩放绘入 (0,0,逻辑宽,逻辑高)
    expect(drawCalls).toEqual([[bitmap, 0, 0, LOGICAL.width, LOGICAL.height]]);
    // 返回去掉 data: 前缀的 base64
    expect(base64).toBe('QUJD');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('canvas 2d 不可用时抛错（调用方捕获后走无图降级），bitmap 仍释放', async () => {
    const bitmap = makeBitmap();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);

    await expect(normalizePngToLogical(new Uint8Array([1]), 10, 10)).rejects.toThrow();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
