/**
 * Dream 触发器
 *
 * 两条腿（任一满足触发，叠加 30s 去抖）：
 *   1. 每日 03:00 + 启动追跑：错过最近一个 03:00 窗口且有新 episode 才补跑——
 *      判据查磁盘的 lastDreamAt（.dream-state.json），不靠进程内计数；
 *      半夜睡/关机错过的窗口，上线时 maybeCatchUp('launch') 补上。
 *   2. 累积 20 条新 episode：高频日提前复盘——故意绕开窗口判据直接跑。
 *
 * 不暴露给 renderer——纯主进程系统级行为。
 *
 * 为何不迁 runtime/systemRoutine（G44 统一内核）：本触发是「每日 + 20 条阈值 + 30s 去抖」复合，且 daily
 * 腿要用磁盘 lastDreamAt 做早触发免疫（见 scheduleDaily 传 next 的缘由）——内核的 interval/daily 简单
 * 声明模型装不下，硬迁反招回归。内核服务的是 autoArchiver/trashCleaner 那类单纯周期例行。
 */
import { runDream } from './dream';
import type { DreamRunOutcome } from '@shared/types';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { getActiveProjectId } from '../agent/activeProject';
import { archiveOldSuperseded } from './archiver';
import { listAllEpisodesWithSuperseded } from './store';
import { readLastDreamAt, writeLastDreamAt } from './dreamState';

const EPISODE_THRESHOLD = 20;
const DEBOUNCE_MS = 30 * 1000;
const DAILY_HOUR = 3;

let dailyTimer: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let cancelDebounce: (() => void) | null = null;
/** 进程内新 episode 计数——只服务 20 条阈值快路；daily / 启动追跑改查磁盘 lastDreamAt，不读它 */
let episodesSinceLastDream = 0;
let inFlight = false;

// ─── 追跑状态（.dream-state.json，读写内核在 dreamState.ts）─────────────

/** ≤now 的最近一个本地复盘时点（DAILY_HOUR，即 03:00）的 epochMs。导出供测试。 */
export function mostRecentDreamHour(now: Date): number {
  const d = new Date(now);
  d.setHours(DAILY_HOUR, 0, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/**
 * 自 since 起有没有没复盘过的 active episode。
 * cutoff = since = lastDreamAt（上次复盘时刻），语义="这条在上次 dream 之后才动过"；
 * 与 dream.ts buildEpisodeIndexText 的固定 30 天窗（决定喂 LLM 多大上下文）语义不同，勿合并。
 */
async function hasUnreviewedEpisodes(owner: string, since: number): Promise<boolean> {
  const eps = await listAllEpisodesWithSuperseded(owner, false); // 只 active，带 mtime
  return eps.some((e) => e.mtime > since);
}

/**
 * 启动 / daily 追跑单一入口：错过最近 03:00 窗口且有新料才补跑。
 * asOf 默认现在；调用方可传特定时刻（见 scheduleDaily 传调度边界的缘由）。
 */
export async function maybeCatchUp(
  reason: string,
  asOf: Date = new Date(),
): Promise<DreamRunOutcome> {
  const owner = getCurrentOwnerId();
  const last = await readLastDreamAt(owner);
  if (last >= mostRecentDreamHour(asOf)) return { kind: 'skipped', reason: 'window-not-missed' };
  if (!(await hasUnreviewedEpisodes(owner, last))) {
    return { kind: 'skipped', reason: 'no-new-episodes' };
  }
  // await 后重检：扫 episode 期间 daily / 阈值腿可能已跑完并推进了 lastDreamAt
  const last2 = await readLastDreamAt(owner);
  if (last2 >= mostRecentDreamHour(asOf)) return { kind: 'skipped', reason: 'window-not-missed' };
  return scheduleSoon(reason); // 复用 30s 去抖 + inFlight
}

/** 启动定时器 */
export function start(): void {
  scheduleDaily();
}

export function stop(): void {
  if (dailyTimer) {
    clearTimeout(dailyTimer);
    dailyTimer = null;
  }
  // 同时取消去抖中的 dream——否则退出后仍会落盘
  if (cancelDebounce) cancelDebounce();
}

/** capture / record_memory 写完 episode 后调一次——累计新 episode 计数（仅服务阈值快路） */
export function onEpisodeWritten(): void {
  episodesSinceLastDream += 1;
  if (episodesSinceLastDream >= EPISODE_THRESHOLD) {
    void scheduleSoon('episode-threshold');
  }
}

function scheduleDaily(): void {
  const now = new Date();
  const next = new Date(now);
  next.setHours(DAILY_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  const ms = next.getTime() - now.getTime();
  dailyTimer = setTimeout(() => {
    // 传调度边界 next（今天 03:00）而非实际触发时刻：setTimeout 可能早触发几毫秒，
    // 用 next 当 asOf 免疫"早触发→mostRecentDreamHour 还停在昨天 03:00→整天判 skip"
    void maybeCatchUp('daily', next).catch(() => undefined);
    scheduleDaily();
  }, ms);
  if (typeof dailyTimer.unref === 'function') dailyTimer.unref();
}

/** 30s 去抖后跑一次 dream。导出仅供测试——产品路径只有 daily / episode 阈值两个内部调用方 */
export async function scheduleSoon(reason: string): Promise<DreamRunOutcome> {
  // leading debounce 守卫：已有 pending timer 时直接跳过——窗口内 pending 那次必跑，
  // 阈值后每条写入的重复触发与 daily 撞窗都被这里吃掉，不再泄漏多个 timer
  if (debounceTimer) return { kind: 'skipped', reason: 'debounce-pending' };
  const cancelled = await new Promise<boolean>((resolve) => {
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      cancelDebounce = null;
      resolve(false);
    }, DEBOUNCE_MS);
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
    cancelDebounce = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      cancelDebounce = null;
      resolve(true);
    };
  });
  if (cancelled) return { kind: 'skipped', reason: 'stopped' };
  return runOnce(reason);
}

export async function runOnce(reason: string): Promise<DreamRunOutcome> {
  if (inFlight) return { kind: 'skipped', reason: 'concurrent-run' };
  inFlight = true;
  try {
    const ownerId = getCurrentOwnerId();
    const summary = await runDream({
      ownerId,
      currentProjectId: getActiveProjectId() ?? null,
    });
    if (summary.kind !== 'failed') {
      episodesSinceLastDream = 0;
      // 推进 lastDreamAt（skipped 空跑也推进，堵住"30 天窗外夹缝"反复触发的循环）。
      // ⚠️ 时间戳必须在 runDream 返回之后取：dream 自己 merge / correct 会 bump active episode
      // 的 mtime，若用入口预采样的旧时刻，bump 后 mtime > lastDreamAt，下次启动会判"有新料"
      // 多跑一次空 dream → 自触发循环。failed 不写（下次启动据旧 lastDreamAt 重试）。
      await writeLastDreamAt(ownerId, Date.now()).catch((e) =>
        console.warn(
          '[oru.dream] writeLastDreamAt failed:',
          e instanceof Error ? e.message : e,
        ),
      );
    } else {
      // 失败退避：计数清到半阈值——再积一半阈值才重试，避免 key 失效期每条写入都轰炸
      episodesSinceLastDream = Math.floor(EPISODE_THRESHOLD / 2);
    }
    logSummary(reason, summary);

    // dream 跑完后跑 archiver 存量兜底（补历史遗留 / relocate 漏网的已标记未移条目）
    await archiveOldSuperseded(ownerId).catch((e) => {
      console.warn('[oru.archiver] failed:', e instanceof Error ? e.message : e);
    });

    return summary;
  } finally {
    inFlight = false;
  }
}

function logSummary(reason: string, s: DreamRunOutcome): void {
  switch (s.kind) {
    case 'ok':
      console.log(
        `[oru.dream] (${reason}) facts=${s.userFactsChanged} project=${s.projectFieldsChanged} merges=${s.episodesMerged} profiles=${s.profileWrites.length}`,
      );
      return;
    case 'skipped':
      console.log(`[oru.dream] (${reason}) skipped: ${s.reason}`);
      return;
    case 'failed':
      console.warn(`[oru.dream] (${reason}) failed: ${s.error}`);
      return;
  }
}

export function __resetForTest(): void {
  stop();
  episodesSinceLastDream = 0;
  inFlight = false;
}

/** v1 兼容：原 onUserMessage 已废弃，保留空 noop 让旧调用方不破坏 */
export function onUserMessage(): void {
  // no-op；触发改为 onEpisodeWritten
}
