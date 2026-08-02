/**
 * 离屏渲染原语的纯逻辑单测：超时/中断闸门（withTimeout）、空白采样（isNearWhite）、内联临时文件（writeTempHtml）。
 * 真离屏渲染 / capturePage / CDP 截图只能在 electron smoke（bootstrap）验，不在此。
 *
 * withTimeout / writeTempHtml 为测试导出的模块内私有原语；isNearWhite 参数收窄到它真实依赖的
 * `Pick<NativeImage,'getSize'|'toBitmap'>`，故无需真 electron、无需裸 as 就能穷举采样分支。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeImage } from 'electron';
import { withTimeout, isNearWhite, writeTempHtml } from '../../electron/main/render/htmlRenderer';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout — 超时 / abort 闸门', () => {
  it('超时 → reject RenderError（message 含 label 与 ms）', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<never>(() => {}), 50, undefined, '加载');
    const assertion = expect(p).rejects.toThrow(/加载.*50ms/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it('signal 已 abort → 立即 reject 取消（不挂 timer、不等 p）', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // p 永不 settle：只要 reject 走的是"已取消"分支就说明没等 p、没挂 timer
    await expect(withTimeout(new Promise<never>(() => {}), 1000, ctrl.signal, '加载')).rejects.toThrow(/取消/);
  });

  it('等待中 abort → reject 取消，且 clearTimeout 生效（不泄漏悬挂 timer）', async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const p = withTimeout(new Promise<never>(() => {}), 1000, ctrl.signal, '加载');
    const assertion = expect(p).rejects.toThrow(/取消/); // abort 抢在超时前，拿到取消而非超时文案
    ctrl.abort();
    await assertion;
    // abort 路径必须 clearTimeout：否则那颗 1000ms timer 悬挂到进程尾（reject-not-toThrow 观测不到，
    // 因 Promise 只 settle 一次；直接数悬挂 timer 才真锁住这条契约）
    expect(vi.getTimerCount()).toBe(0);
  });

  it('p resolve → 透传值；addEventListener 与 removeEventListener 配平（无 listener 泄漏）', async () => {
    const ctrl = new AbortController();
    const addSpy = vi.spyOn(ctrl.signal, 'addEventListener');
    const removeSpy = vi.spyOn(ctrl.signal, 'removeEventListener');
    expect(await withTimeout(Promise.resolve(42), 1000, ctrl.signal, '加载')).toBe(42);
    expect(removeSpy).toHaveBeenCalledTimes(addSpy.mock.calls.length);
  });

  it('p reject → 包装成 RenderError（渲染失败：原因）', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, undefined, '加载')).rejects.toThrow(
      /渲染失败：boom/,
    );
  });
});

describe('isNearWhite — 采样判空白', () => {
  // 16×16 图：采样点 x=gx、y=gy（floor((g+0.5)*(16/16))=g），即每个像素都被采样一次，可精确构造密度。
  const SIZE = 16;

  /** 全填同一灰度（BGR=fill，A=255）的 16×16 BGRA 位图。 */
  const solid = (fill: number): Buffer => {
    const buf = Buffer.alloc(SIZE * SIZE * 4);
    for (let i = 0; i < SIZE * SIZE; i += 1) {
      buf[i * 4] = fill;
      buf[i * 4 + 1] = fill;
      buf[i * 4 + 2] = fill;
      buf[i * 4 + 3] = 255;
    }
    return buf;
  };

  /** 全白底、前 n 个像素置黑（= n 个采样点非白）。 */
  const whiteWith = (nonWhite: number): Buffer => {
    const buf = solid(255);
    for (let i = 0; i < nonWhite; i += 1) buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = 0;
    return buf;
  };

  const img = (width: number, height: number, bmp: Buffer): Pick<NativeImage, 'getSize' | 'toBitmap'> => ({
    getSize: () => ({ width, height }),
    toBitmap: () => bmp,
  });

  it('全白 → 空白', () => {
    expect(isNearWhite(img(SIZE, SIZE, solid(255)))).toBe(true);
  });

  it('全黑 → 非空白', () => {
    expect(isNearWhite(img(SIZE, SIZE, solid(0)))).toBe(false);
  });

  it('阈值边界：248 仍算白（空白）、247 算非白（非空白）', () => {
    // r/g/b < 248 才算非白：全 248 → 全白 → 空白；全 247 → 全非白 → 非空白
    expect(isNearWhite(img(SIZE, SIZE, solid(248)))).toBe(true);
    expect(isNearWhite(img(SIZE, SIZE, solid(247)))).toBe(false);
  });

  it('密度边界：非白占比 <1% 仍空白、≥1% 翻为非空白（256 采样点）', () => {
    // 2/256=0.78% <1% → 空白；3/256=1.17% ≥1% → 非空白
    expect(isNearWhite(img(SIZE, SIZE, whiteWith(2)))).toBe(true);
    expect(isNearWhite(img(SIZE, SIZE, whiteWith(3)))).toBe(false);
  });

  it('零尺寸 → 空白（不采样、不越界）', () => {
    expect(isNearWhite(img(0, 0, Buffer.alloc(0)))).toBe(true);
    expect(isNearWhite(img(0, 10, Buffer.alloc(0)))).toBe(true);
  });
});

describe('writeTempHtml — 内联 HTML 落盘', () => {
  let baseDir: string;

  afterEach(async () => {
    if (baseDir) await rm(baseDir, { recursive: true, force: true });
  });

  it('写到 baseDir 下、.render-tmp- 前缀 .html 后缀，内容原样', async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'render-tmp-'));
    const html = '<h1>Hi</h1>';
    const path = await writeTempHtml(html, baseDir);
    expect(path.startsWith(baseDir)).toBe(true);
    expect(path).toMatch(/[/\\]\.render-tmp-.*\.html$/);
    expect(await readFile(path, 'utf-8')).toBe(html);
  });

  it('连续两次生成不同文件名（不互相覆盖）', async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'render-tmp-'));
    const a = await writeTempHtml('<p>a</p>', baseDir);
    const b = await writeTempHtml('<p>b</p>', baseDir);
    expect(a).not.toBe(b);
    expect(await readFile(a, 'utf-8')).toBe('<p>a</p>');
    expect(await readFile(b, 'utf-8')).toBe('<p>b</p>');
  });
});
