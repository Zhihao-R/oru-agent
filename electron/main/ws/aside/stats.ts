/**
 * 随手评点的朴素本地计数（二期 §8）——JSON 单文件 + batched flush（仿 memory/accessLog.ts），
 * 无 UI（三期看数时再说）、无上报、纯本地。不打分不评判，只让三期调什么有数可看。
 *
 * 事件→指标映射写死（capture 不能当 ⌥ 点的代理——deck 点击的截图由 host 自调
 * wv.capturePage，不经 aside.capture）：
 * - ⌥ 点次数 = comments（probing 每点必发 aside.comment）+ addReferents（chatting 每递进必发）
 * - 开口次数 = begins（aside.begin 成功）
 * - 转正次数 = promotes（aside.promote 成功）
 * 按本地日期分桶：开口率 = begins/⌥点、转正率 = promotes/begins、
 * 「点过的人还来不来点」= 有活动的日子分布——全部离线从日桶推导，不在线上算。
 *
 * 计数丢失的边界与 accessLog 同口径：批量窗口（10s）内退出会丢未 flush 的增量，接受。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { safeWriteAsync } from '../../fs/safeWrite';
import { userDir } from '../../runtime/paths';

export type AsideEventKind = 'comment' | 'addReferent' | 'begin' | 'promote';

/** 事件来源：窗内（老路，主窗 ⌥ 点）/ 窗外（唤起对话，整屏 ⌥ 点） */
export type AsideEventSource = 'window' | 'screen';

/**
 * 单日计数桶；字段名 = 事件复数形。
 * 不含 screen 前缀的字段是「窗内 + 窗外」总量（口径不变，老数据兼容）；screen* 是窗外子集——
 * 窗外占比 = screenComments / comments、窗内 = comments − screenComments（唤起对话 PRD §9 度量出口）。
 */
type DayBucket = {
  comments: number;
  addReferents: number;
  begins: number;
  promotes: number;
  screenComments: number;
  screenAddReferents: number;
  screenBegins: number;
  screenPromotes: number;
};
type StatsMap = Record<string, DayBucket>; // 'YYYY-MM-DD'（本地时区）→ 桶

const KIND_FIELD: Record<AsideEventKind, keyof DayBucket> = {
  comment: 'comments',
  addReferent: 'addReferents',
  begin: 'begins',
  promote: 'promotes',
};
/** 窗外子集字段——screen 来源的事件在总量之外再记一笔（窗外占比的分子） */
const SCREEN_KIND_FIELD: Record<AsideEventKind, keyof DayBucket> = {
  comment: 'screenComments',
  addReferent: 'screenAddReferents',
  begin: 'screenBegins',
  promote: 'screenPromotes',
};

function emptyBucket(): DayBucket {
  return {
    comments: 0,
    addReferents: 0,
    begins: 0,
    promotes: 0,
    screenComments: 0,
    screenAddReferents: 0,
    screenBegins: 0,
    screenPromotes: 0,
  };
}

/** ~/.oru/users/<ownerId>/aside-stats.json */
function statsPath(ownerId: string): string {
  return join(userDir(ownerId), 'aside-stats.json');
}

const cache = new Map<string, StatsMap>(); // ownerId → map
const loading = new Map<string, Promise<StatsMap>>(); // 首次加载合流（RMW 不原子，见 accessLog）
const dirty = new Set<string>();
const flushTimers = new Map<string, NodeJS.Timeout>();

const FLUSH_DELAY_MS = 10_000;

async function load(ownerId: string): Promise<StatsMap> {
  const cached = cache.get(ownerId);
  if (cached) return cached;
  const inflight = loading.get(ownerId);
  if (inflight) return inflight;
  const p = (async () => {
    let map: StatsMap = {};
    try {
      map = JSON.parse(await fs.readFile(statsPath(ownerId), 'utf-8')) as StatsMap;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // 不存在 → 空 map
      } else {
        // 文件损坏（坏 JSON 等）→ 清零重来：统计是低价值数据，宁可清零不可哑火——
        // 一直 throw 会让此后每次 recordAsideEvent 静默失败且永不自愈
        console.warn('[aside.stats] 统计文件损坏，清零重建:', e instanceof Error ? e.message : e);
      }
    }
    cache.set(ownerId, map);
    return map;
  })();
  p.finally(() => loading.delete(ownerId)).catch(() => {});
  loading.set(ownerId, p);
  return p;
}

/** 本地时区的 YYYY-MM-DD——使用分析按用户的「一天」算，不用 UTC */
function localDayKey(at: number): string {
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function flush(ownerId: string): Promise<void> {
  if (!dirty.has(ownerId)) return;
  const map = cache.get(ownerId);
  if (!map) return;
  // 原子写（项目约定：文本落盘一律走 safeWrite 内核）——torn write 出半截 JSON
  // 会让 load 走「清零重建」，历史计数整份蒸发，不值得为省一次 rename 冒这险
  await safeWriteAsync(statsPath(ownerId), JSON.stringify(map, null, 2));
  dirty.delete(ownerId);
  flushTimers.delete(ownerId);
}

function scheduleFlush(ownerId: string): void {
  if (flushTimers.has(ownerId)) return;
  const timer = setTimeout(() => {
    void flush(ownerId);
  }, FLUSH_DELAY_MS);
  // 让进程能正常退出，不被 timer 阻塞
  if (typeof timer.unref === 'function') timer.unref();
  flushTimers.set(ownerId, timer);
}

/** 记一次评点事件；失败静默（计数绝不能影响评点主链路） */
export async function recordAsideEvent(
  ownerId: string,
  kind: AsideEventKind,
  at: number = Date.now(),
  source: AsideEventSource = 'window',
): Promise<void> {
  try {
    const map = await load(ownerId);
    const key = localDayKey(at);
    const bucket = (map[key] ??= emptyBucket());
    bucket[KIND_FIELD[kind]] += 1; // 总量（口径不变）
    if (source === 'screen') bucket[SCREEN_KIND_FIELD[kind]] += 1; // 窗外子集
    dirty.add(ownerId);
    scheduleFlush(ownerId);
  } catch (e) {
    console.warn('[aside.stats] 计数失败（静默）:', e instanceof Error ? e.message : e);
  }
}

/** 立即 flush 所有 owner（关机前 / 测试用） */
export async function flushAsideStats(): Promise<void> {
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
