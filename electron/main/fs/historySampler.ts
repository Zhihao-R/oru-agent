/**
 * 周期取样器（md/csv 的快照调度，技术设计 §4）。
 *
 * 落盘节奏（≤0.8s debounce）与快照节奏（~3min 周期）是两件事、各司其职：落盘只为「磁盘=屏幕、AI 读最新」，
 * 快照为「能后悔」。连续猛改一小时若只靠「停手才存」反而一个底都没有——所以用固定周期取样：
 * 活跃文件每 ~3min 读磁盘 snapshot('periodic')，内容没变在 FileHistory 层 no-op（不存重复）。
 *
 * 真相源是磁盘（实时落盘后磁盘即最新），取样器只读磁盘、不碰渲染端内存——register/unregister
 * 由编辑器打开/关闭文件驱动，touch 由每次落盘驱动（标记「这一周期有新编辑」，静止则跳过取样不空转）。
 */
import { existsSync } from 'node:fs';
import { readWithMetaAsync } from './safeWrite';
import * as fileHistory from './fileHistory';

/** 周期取样间隔；初始 3min（PRD 设计参数 3，实测后可调；大文件靠 FileHistory GC 降频，不动这里） */
export const SAMPLE_INTERVAL_MS = 3 * 60 * 1000;

type Sampler = {
  timer: ReturnType<typeof setInterval>;
  /** 上次取样后是否有过编辑——无则本周期跳过，静止不空转 */
  dirtySinceLastTick: boolean;
};

const samplers = new Map<string, Sampler>();

/** 编辑器打开文件时注册周期取样（已注册则幂等）。absPath = 工作文件绝对路径 = fileKey。 */
export function registerSampling(absPath: string): void {
  if (samplers.has(absPath)) return;
  const timer = setInterval(() => {
    void tick(absPath);
  }, SAMPLE_INTERVAL_MS);
  // 不阻止进程退出（before-quit flush 走各自的立即落盘，不靠这个定时器）
  if (typeof timer.unref === 'function') timer.unref();
  samplers.set(absPath, { timer, dirtySinceLastTick: false });
}

/** 每次落盘后调，标记本周期有新编辑（下次 tick 才会真去取样）。 */
export function touchSampling(absPath: string): void {
  const s = samplers.get(absPath);
  if (s) s.dirtySinceLastTick = true;
}

/**
 * 编辑器关闭文件时注销（清定时器）。若本轮编辑过，补一个可见锚——让「关闭那一刻」在历史里留个能回去
 * 的时间点（overwrite-guard 隐藏后这段窗口否则无新可见锚）。captureNow 不读 samplers，故先 delete 再补存也无碍。
 */
export function unregisterSampling(absPath: string): void {
  const s = samplers.get(absPath);
  if (!s) return;
  clearInterval(s.timer);
  samplers.delete(absPath);
  if (s.dirtySinceLastTick) void captureNow(absPath);
}

/** 仅测试用：清掉所有取样器，避免用例间残留定时器。 */
export function __resetForTest(): void {
  for (const s of samplers.values()) clearInterval(s.timer);
  samplers.clear();
}

/** 仅测试用：直接跑一次取样 tick 并 await 完成（绕开 fake timer 等不到真实 fs I/O 的脆弱）。 */
export function __tickForTest(absPath: string): Promise<void> {
  return tick(absPath);
}

async function tick(absPath: string): Promise<void> {
  const s = samplers.get(absPath);
  if (!s || !s.dirtySinceLastTick) return; // 静止不空转
  s.dirtySinceLastTick = false;
  await captureNow(absPath);
}

/** 读磁盘当前版、存一个 periodic 快照。周期 tick 与关闭补锚共用——不碰 samplers，可在任意时机调。 */
async function captureNow(absPath: string): Promise<void> {
  if (!existsSync(absPath)) return;
  try {
    const content = (await readWithMetaAsync(absPath)).content; // 与落盘路径同口径，hash 一致
    await fileHistory.snapshot(absPath, 'periodic', content); // 内容没变 → 层内 no-op 返回 null
  } catch {
    // 读失败（文件被删/权限）——放弃，不抛
  }
}
