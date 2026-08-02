/**
 * 回收站清除 · 独立每日定时程序（S35·G36）
 *
 * 理想页「清除」节：清掉回收站里满 30 天的条目是「满 30 天即删」的机械动作，不需要判断力——
 * 由独立的程序每日定时执行，**不经 dream**（dream 只做需要全局视角的归并/升格/退休）。
 * 此前 cleanupOldTrash 挂在 dream 末尾顺带跑，dream 被 skip / 失败则回收站永不清。
 *
 * 调度（比 dream 简单：cleanupOldTrash 幂等，只删 >30 天目录，重复跑无副作用）：
 *   1. 启动即扫一次（maybeCatchUp('launch') 的等价物——补上关机期间错过的清除窗口）
 *   2. 每天定点（04:00，排在 dream 03:00 之后）再扫一次
 *
 * 不暴露给 renderer——纯主进程系统级例行。
 */
import { cleanupOldTrash } from './trash';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { createSystemRoutine } from '../runtime/systemRoutine';

/** 回收站保留期（天）——与 trash.ts 默认一致 */
const RETENTION_DAYS = 30;
/** 每日清除时点（本地 04:00，排在 dream 的 03:00 之后） */
const DAILY_HOUR = 4;

/** 扫一次：清当前 owner 回收站里满 30 天的目录。失败静默——best-effort、下次再来。 */
async function sweep(reason: string): Promise<number> {
  try {
    const owner = getCurrentOwnerId();
    const deleted = await cleanupOldTrash(owner, RETENTION_DAYS);
    if (deleted > 0) console.log(`[oru.trash] (${reason}) purged ${deleted} 个过期回收站目录`);
    return deleted;
  } catch (e) {
    console.warn('[oru.trash] sweep failed:', e instanceof Error ? e.message : e);
    return 0;
  }
}

// 统一调度内核（G44）：daily 04:00 触发 + 开机补扫；启停/防重入由内核保证。
const routine = createSystemRoutine({
  id: 'trashCleaner',
  trigger: { kind: 'daily', hour: DAILY_HOUR },
  run: async () => {
    await sweep('routine');
  },
  runOnStart: true,
});

export function start(): void {
  routine.start();
}

export function stop(): void {
  routine.stop();
}

/** 测试用：直接跑一次扫描 */
export { sweep as __sweepForTest };
