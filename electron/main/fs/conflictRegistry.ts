/**
 * S29·G90 未决冲突卡的按文件全局登记——冲突卡收口③④的承重态（不限哪个回合 / subagent 发起）。
 *
 * 两层：
 *  - open（持久）：哪些文件此刻开着冲突卡。落盘只为崩溃重开提示可找回；进程内以内存 Set 为准。
 *  - deferred（内存）：冲突未决期间被挂起（并行 defer）的 AI 写入来自哪些对话。裁决后据它起新轮把结果
 *    交回 AI；崩溃丢失无妨——那些回合本身已随进程消失。
 *
 * key = 工作文件规范化绝对路径（= FileHistory fileKey / workfile 锁 key）。本模块对外一律 resolve 归一，
 * 与 workfileWrite / fileHistory 同一字面，否则同一文件被劈成两条挂起账（review C-1 同源）。
 */
import { resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { safeWriteAsync } from './safeWrite';
import { openConflictsPath } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';

const openConflicts = new Set<string>();
const deferredWrites = new Map<string, Set<string>>();

// 落盘串行化：每次都写全量集合，若多次 persist 并发（不同文件先后开卡）overlap，晚完成的旧写会覆盖新写。
// 串成一条链保证按调用序落盘、末次写=最终态（承重只是崩溃重开提示，但错乱无意义）。
let persistChain: Promise<void> = Promise.resolve();
function schedulePersist(): void {
  const run = async (): Promise<void> => {
    try {
      await safeWriteAsync(openConflictsPath(getCurrentOwnerId()), JSON.stringify([...openConflicts]));
    } catch {
      // 落盘失败只影响「崩溃重开提示」，不影响进程内挂起判定——静默（与 feeds 的事件型信号同族）
    }
  };
  persistChain = persistChain.then(run, run);
}

/** 该文件此刻是否开着冲突卡（AI 写入据此判是否挂起）。 */
export function isConflictOpen(fileKey: string): boolean {
  return openConflicts.has(resolve(fileKey));
}

/** 开卡登记（渲染端 snapshotConflictPair 成功后调）。持久化供崩溃重开提示。 */
export function markConflictOpen(fileKey: string): void {
  const key = resolve(fileKey);
  if (openConflicts.has(key)) return;
  openConflicts.add(key);
  schedulePersist();
}

/**
 * 记一笔被挂起的 AI 写入来自哪个对话（AI 写入撞未决冲突、并行 defer 时调）。只在该文件真开着卡时记，
 * 避免脏账。裁决后 clearConflict 据此起新轮把结果交回这些对话。
 */
export function recordDeferredWrite(fileKey: string, conversationId: string): void {
  const key = resolve(fileKey);
  if (!openConflicts.has(key)) return;
  let set = deferredWrites.get(key);
  if (!set) deferredWrites.set(key, (set = new Set()));
  set.add(conversationId);
}

/**
 * 裁决收起：撤登记 + 取走被挂起的对话 id（供起新轮交回裁决）。返回去重后的对话 id 列表（无挂起则空）。
 */
export function clearConflict(fileKey: string): string[] {
  const key = resolve(fileKey);
  openConflicts.delete(key);
  const convs = [...(deferredWrites.get(key) ?? [])];
  deferredWrites.delete(key);
  schedulePersist();
  return convs;
}

/**
 * 崩溃重启扫描（boot 早期、ws 起来前调）：读上次进程残留的未决冲突文件清单，返回给调用方发「可找回」信号，
 * 然后清空持久档与内存——残留冲突态随渲染端已丢，只留历史里的双方版本 + 一次信号（与 steering 崩溃盘记同纪律：
 * 早于新写者扫完，晚扫会误判本进程新登记为残留）。
 */
export async function scanOpenConflictsOnBoot(): Promise<string[]> {
  const path = openConflictsPath(getCurrentOwnerId());
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf-8'));
    if (Array.isArray(parsed)) keys = parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    // 无残留 / 读抖动 / 损坏——按无残留处理
  }
  openConflicts.clear();
  deferredWrites.clear();
  await fs.unlink(path).catch(() => undefined);
  return keys;
}

/** 测试用：等落盘链清空（persist 是 fire-and-forget，测试断言前 await 它）。 */
export function __flushPersistForTest(): Promise<void> {
  return persistChain;
}

/** 测试用：清零内存态（避免用例间串味）。 */
export function __resetConflictRegistryForTest(): void {
  openConflicts.clear();
  deferredWrites.clear();
}
