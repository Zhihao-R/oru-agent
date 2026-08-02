/**
 * 按用途归账的用量账本（理想架构 S13 · G110）
 *
 * 计量不是新机制，是接入层唯一入口的副产品：每次模型调用都带用途（getBackendFor 的分配单位）、
 * 事件流本就上报 result.usage，两者在 meterBackend 处合流落到这里。本模块只负责聚合与落盘。
 *
 * 落盘范式仿 ws/aside/stats.ts / memory/accessLog.ts：内存聚合 + 首次加载合流 + 批量 flush +
 * before-quit 强制 flush；批量窗口内退出丢未 flush 的增量，接受（账本是用户可见的粗聚合，不是
 * 计费级凭据——比 aside 计数高一档但远不到身份数据，故不进 data-durability 六类纪律、损坏即清零
 * 重建而非隔离告知）。RMW 不原子由「首次加载合流」兜住（同 accessLog）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { LlmUsage } from '@shared/types';
import type { UsageBucket, UsageLedgerFile } from '@shared/usage/types';
import { localDayKey } from '@shared/usage/summarize';
import { safeWriteAsync } from '../fs/safeWrite';
import { userDir } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';

// summarizeUsage 已移到 @shared/usage/summarize（纯函数、两端共用）；本模块只管聚合与落盘。

const LEDGER_VERSION = 1;
const FLUSH_DELAY_MS = 10_000;

/** ~/.oru/users/<ownerId>/usage-ledger.json */
function ledgerPath(ownerId: string): string {
  return join(userDir(ownerId), 'usage-ledger.json');
}

type DaysMap = UsageLedgerFile['days'];

const cache = new Map<string, DaysMap>(); // ownerId → 日桶
const loading = new Map<string, Promise<DaysMap>>(); // 首次加载合流（RMW 不原子）
const dirty = new Set<string>();
const flushTimers = new Map<string, NodeJS.Timeout>();

/**
 * 落盘后回调（S15 预算信号重评挂这里；DI 注入避免 ledger 反向依赖 budget）。软警戒是「事前
 * 警戒」——用量一涨就该重评，挂在 flush 后（≤10s 一批）足够及时，又不必每笔 record 都算一次。
 */
let flushObserver: ((ownerId: string) => void) | null = null;
export function setLedgerFlushObserver(fn: ((ownerId: string) => void) | null): void {
  flushObserver = fn;
}

async function load(ownerId: string): Promise<DaysMap> {
  const cached = cache.get(ownerId);
  if (cached) return cached;
  const inflight = loading.get(ownerId);
  if (inflight) return inflight;
  const p = (async () => {
    let days: DaysMap = {};
    try {
      const parsed = JSON.parse(await fs.readFile(ledgerPath(ownerId), 'utf-8')) as Partial<UsageLedgerFile>;
      // 版本未来于本程序时不冒险改写（不倒退版本）；同版 / 更旧都取 days（v1 无破坏性演进）。
      if (parsed && typeof parsed === 'object' && parsed.days && (parsed.version ?? LEDGER_VERSION) <= LEDGER_VERSION) {
        days = parsed.days;
      } else if (parsed?.version && parsed.version > LEDGER_VERSION) {
        console.warn(`[usage.ledger] 账本版本 ${parsed.version} 高于本程序 ${LEDGER_VERSION}——本次不聚合旧数据`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 损坏 → 清零重建：账本是低价值聚合，一直 throw 会让此后每次 recordUsage 静默失败且不自愈
        console.warn('[usage.ledger] 账本损坏，清零重建:', e instanceof Error ? e.message : e);
      }
    }
    cache.set(ownerId, days);
    return days;
  })();
  p.finally(() => loading.delete(ownerId)).catch(() => {});
  loading.set(ownerId, p);
  return p;
}

async function flush(ownerId: string): Promise<void> {
  if (!dirty.has(ownerId)) return;
  const days = cache.get(ownerId);
  if (!days) return;
  // 强制 flush（quit / 测试）可能早于 debounce 到期——成对清掉悬挂 timer，别留孤儿（副作用生命周期）
  const timer = flushTimers.get(ownerId);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(ownerId);
  }
  const file: UsageLedgerFile = { version: LEDGER_VERSION, days };
  await safeWriteAsync(ledgerPath(ownerId), JSON.stringify(file, null, 2));
  dirty.delete(ownerId);
  flushObserver?.(ownerId);
}

function scheduleFlush(ownerId: string): void {
  if (flushTimers.has(ownerId)) return;
  const timer = setTimeout(() => void flush(ownerId), FLUSH_DELAY_MS);
  if (typeof timer.unref === 'function') timer.unref();
  flushTimers.set(ownerId, timer);
}

/**
 * 记一次模型调用的用量（按用途累计到当日桶）。失败静默——计量绝不能影响主链路。
 * fire-and-forget：调用方 `void recordUsage(...)`，不阻塞事件流 / oneShot 返回。
 * inputTokens / outputTokens 缺省算 0，但只要 usage 上报了本条就计入 calls（回合确实发生了）。
 */
export async function recordUsage(
  purpose: LlmUsage,
  tokens: { inputTokens?: number; outputTokens?: number },
  at: number = Date.now(),
  ownerId: string = getCurrentOwnerId(),
): Promise<void> {
  try {
    const days = await load(ownerId);
    const key = localDayKey(at);
    const dayBucket = (days[key] ??= {});
    const bucket: UsageBucket = (dayBucket[purpose] ??= { inputTokens: 0, outputTokens: 0, calls: 0 });
    bucket.inputTokens += tokens.inputTokens ?? 0;
    bucket.outputTokens += tokens.outputTokens ?? 0;
    bucket.calls += 1;
    dirty.add(ownerId);
    scheduleFlush(ownerId);
  } catch (e) {
    console.warn('[usage.ledger] 记账失败（静默）:', e instanceof Error ? e.message : e);
  }
}

/** 读全量日桶（供渲染层聚合 / S15 预算闸门 / 测试）。 */
export async function getUsageDays(ownerId: string = getCurrentOwnerId()): Promise<DaysMap> {
  return load(ownerId);
}

/** 关机前 / 测试用：立即 flush 所有 owner。 */
export async function flushUsageLedger(): Promise<void> {
  for (const ownerId of Array.from(dirty)) {
    await flush(ownerId);
  }
}

/** 测试用：清空 in-memory cache 与 timer。 */
export function __resetUsageLedgerForTest(): void {
  for (const t of flushTimers.values()) clearTimeout(t);
  flushTimers.clear();
  cache.clear();
  loading.clear();
  dirty.clear();
  flushObserver = null;
}
