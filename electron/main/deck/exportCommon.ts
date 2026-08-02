/**
 * deck 导出的两件共用小事：产物路径派生 + 原子落盘。四种格式（HTML/PDF/PPT）共用一处。
 */
import { promises as fs } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import os from 'node:os';

/**
 * 图片版导出的离屏渲染并发数。导出期间全屏蒙尘、UI 已停，不必像交互期（默认 4）那样保守——
 * 按 CPU 逻辑核数抢墙钟。实测（20 页 @dsf=2）：4→12 约快 22%，超过核数反因 GPU/CPU 竞争变慢，
 * 故钳在 [4,12]（下限保底不低于交互默认，上限防大 deck 同时开十几个离屏窗口耗内存/反变慢）。
 */
export function exportRenderConcurrency(): number {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(4, Math.min(12, cores));
}

/**
 * 设计 px → 英寸：96 DPI 下 1 CSS px = 1/96 英寸。PDF 的 printToPDF pageSize 与 PPT 的 pptx
 * 版面单位都是英寸，故一张设计稿 px / 96 = 一页英寸尺寸、宽高比与画布一致。两处导出共用此换算。
 */
export const INCHES_PER_PX = 1 / 96;

/**
 * 撞名不覆盖、加序号另存的路径派生内核：`<dir>/<baseName>.ext → <baseName>-2.ext → -3.ext …`
 * （与表格导出 exportXlsx 同款约定），让用户每次导出都留一份、不悄悄替换上一份。
 * 两类消费者派生方式不同（deck 按目录、md 按文件），故初值各自算、撞名循环这一份共用（系统性）。
 */
export async function firstFreePath(dir: string, baseName: string, ext: string): Promise<string> {
  let out = join(dir, `${baseName}.${ext}`);
  for (let i = 2; ; i += 1) {
    const exists = await fs.access(out).then(() => true, () => false);
    if (!exists) return out;
    out = join(dir, `${baseName}-${i}.${ext}`);
  }
}

/**
 * deck 导出物路径：deck 目录名（已 sanitize 过——pathResolver.sanitizeDeckName）+ 扩展名，落在 deck 目录内。
 * 不用 ArtifactRecord.name——那是用户原始输入，可能含 `/ : *`。
 */
export async function exportPath(deckPath: string, ext: string): Promise<string> {
  return firstFreePath(deckPath, basename(deckPath), ext);
}

/**
 * 原子落盘：先写 `.<名>.tmp` 再 rename，保证导出中途失败不在目录留下半成品（PRD 要求）。
 * 收 string | Buffer——`fs/safeWrite.ts` 只收 string，PDF/PPT 的 Buffer 产物也要这层"无残件"
 * 保证，故在此独立实现（与 safeWrite 同一 tmp+rename 理念，不共享内核因入参类型不同）。
 */
export async function writeExportAtomic(outPath: string, data: string | Buffer): Promise<void> {
  const tmp = join(dirname(outPath), `.${basename(outPath)}.tmp`);
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, outPath);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
