/**
 * .access-log.json — 记忆文件的使用分析数据源（决策 3 / Task 5）
 *
 * 为什么单独存：每次 Twin 召回一条记忆都要更新引用记录，
 * 如果直接写到记忆文件本身的 frontmatter，会引发：
 * - 用户在编辑器里打开记忆文件 → Twin 召回更新 frontmatter → 用户保存时冲突
 * - 文件夹是 git repo 时每次召回都产生 dirty change
 *
 * 拆出来后记忆文件保持稳定不动，访问记录集中在一份 JSON 里维护。
 * 写入是 batched 的（每 10 秒 flush 一次），避免高频 I/O。
 *
 * v2 结构（从单时间戳升级为计数 + 首末时间，撑得起"使用分析"）：
 *   { "<absPath>": { count, firstAt, lastAt }, ... }
 * 旧格式（{ "<absPath>": <unix-ms> }）由 load() 兼容升级，不分访问通道（count 已够用，
 * 分通道无落地消费方，等真有需求再加——见 tech doc 决策 3）。
 */
import { promises as fs } from 'node:fs';
import { safeWriteAsync } from '../fs/safeWrite';
import { accessLogPath } from './paths';

export type AccessEntry = { count: number; firstAt: number; lastAt: number };
type AccessMap = Record<string, AccessEntry>;
/** 磁盘上可能是旧格式（number）或新格式（AccessEntry）——load() 统一升级成 AccessEntry */
type RawAccessMap = Record<string, AccessEntry | number>;

const cache = new Map<string, AccessMap>(); // ownerId → map
const loading = new Map<string, Promise<AccessMap>>(); // 首次加载合流，避免并发各读各的
const dirty = new Set<string>(); // ownerIds with unflushed changes
const flushTimers = new Map<string, NodeJS.Timeout>();

const FLUSH_DELAY_MS = 10_000;

async function load(ownerId: string): Promise<AccessMap> {
  const cached = cache.get(ownerId);
  if (cached) return cached;
  // 合流：并发的首次 recordAccess 共享同一个读盘 promise，拿到同一个 map 对象，
  // 否则各自 readFile → 各自 cache.set 互相覆盖，先写的 count++ 丢失（RMW 不原子）。
  const inflight = loading.get(ownerId);
  if (inflight) return inflight;
  const p = (async () => {
    const path = accessLogPath(ownerId);
    let map: AccessMap = {};
    try {
      const text = await fs.readFile(path, 'utf-8');
      map = upgradeRaw(JSON.parse(text) as RawAccessMap);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // 不存在 → 空 map
      } else {
        // 文件损坏（坏 JSON 等）→ 清零重来（同构：ws/aside/stats.ts）：访问记录是低价值数据，
        // 宁可清零不可哑火——一直 throw 会让此后每次 grep_memory/read_memory 都抛错且永不自愈
        console.warn('[memory.accessLog] 访问记录文件损坏，清零重建:', e instanceof Error ? e.message : e);
      }
    }
    cache.set(ownerId, map);
    return map;
  })();
  // 无论成功失败都从 loading 摘除——失败若不摘，后续会一直拿到这个 rejected promise，永远恢复不了。
  p.finally(() => loading.delete(ownerId)).catch(() => {});
  loading.set(ownerId, p);
  return p;
}

/** 旧格式兼容：值是 number（旧单时间戳）→ { count:1, firstAt:v, lastAt:v } */
function upgradeRaw(raw: RawAccessMap): AccessMap {
  const out: AccessMap = {};
  for (const [path, v] of Object.entries(raw)) {
    if (typeof v === 'number') {
      out[path] = { count: 1, firstAt: v, lastAt: v };
    } else if (v && typeof v === 'object' && typeof v.lastAt === 'number') {
      out[path] = { count: v.count ?? 1, firstAt: v.firstAt ?? v.lastAt, lastAt: v.lastAt };
    }
    // 其它脏值静默跳过——不让坏数据产生 NaN
  }
  return out;
}

async function flush(ownerId: string): Promise<void> {
  if (!dirty.has(ownerId)) return;
  const map = cache.get(ownerId);
  if (!map) return;
  // 原子写（项目约定：文本落盘一律走 safeWrite 内核）——torn write 出半截 JSON
  // 会让 load 走「清零重建」，历史计数整份蒸发，不值得为省一次 rename 冒这险
  await safeWriteAsync(accessLogPath(ownerId), JSON.stringify(map, null, 2));
  dirty.delete(ownerId);
  flushTimers.delete(ownerId);
}

function scheduleFlush(ownerId: string): void {
  if (flushTimers.has(ownerId)) return;
  const timer = setTimeout(() => {
    void flush(ownerId);
  }, FLUSH_DELAY_MS);
  // 让 Node 进程能正常退出，不被 timer 阻塞
  if (typeof timer.unref === 'function') timer.unref();
  flushTimers.set(ownerId, timer);
}

/** 记一条访问：count 累加、firstAt 不被覆盖、lastAt 更新（签名不变） */
export async function recordAccess(ownerId: string, absPath: string, at: number = Date.now()): Promise<void> {
  const map = await load(ownerId);
  const e = map[absPath];
  if (e) {
    e.count += 1;
    e.firstAt = Math.min(e.firstAt, at);
    e.lastAt = Math.max(e.lastAt, at);
  } else {
    map[absPath] = { count: 1, firstAt: at, lastAt: at };
  }
  dirty.add(ownerId);
  scheduleFlush(ownerId);
}

/** 查一条记忆的最后引用时间（lastAt），没记录返回 null */
export async function getAccessTime(ownerId: string, absPath: string): Promise<number | null> {
  const map = await load(ownerId);
  return map[absPath]?.lastAt ?? null;
}

/** 列出超过 thresholdDays 天没被引用的文件路径（按 lastAt 比较） */
export async function getStaleFiles(
  ownerId: string,
  thresholdDays: number,
  now: number = Date.now(),
): Promise<string[]> {
  const map = await load(ownerId);
  const cutoff = now - thresholdDays * 24 * 60 * 60 * 1000;
  return Object.entries(map)
    .filter(([, e]) => e.lastAt < cutoff)
    .map(([path]) => path);
}

/** 一条使用统计（给"最常用 / 从没用过"消费方） */
export type UsageStat = { path: string; count: number; lastAt: number };

/**
 * 使用统计：按 count 降序（次之 lastAt 降序）。
 *
 * - 不传 knownPaths → 只返回**被记录过**的文件（top-N 取头部）。
 * - 传 knownPaths（记忆文件全集）→ 额外把"从没被读"的补成 count:0 项（取 count===0 即"从没读"清单）。
 *   access-log 本身只知被读过的文件，"从没读"必须对照全集——所以全集由消费方传入。
 *
 * 不变量：使用频率**不**用于注入排序（评估 §9.3 已第一性否决：被检索≠有用）。
 */
export async function getUsageStats(ownerId: string, knownPaths?: string[]): Promise<UsageStat[]> {
  const map = await load(ownerId);
  const stats: UsageStat[] = Object.entries(map).map(([path, e]) => ({
    path,
    count: e.count,
    lastAt: e.lastAt,
  }));
  if (knownPaths) {
    for (const p of knownPaths) {
      if (!map[p]) stats.push({ path: p, count: 0, lastAt: 0 });
    }
  }
  stats.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  return stats;
}

/** 立即 flush 所有 owner（关机前 / 测试用） */
export async function flushAll(): Promise<void> {
  for (const ownerId of Array.from(dirty)) {
    await flush(ownerId);
  }
}

/** 测试用：清空 in-memory cache 和 timer */
export function __resetForTest(): void {
  for (const t of flushTimers.values()) clearTimeout(t);
  flushTimers.clear();
  cache.clear();
  loading.clear();
  dirty.clear();
}
