/**
 * 系统信号的四类源接入（理想架构 S14 · G106）——各源把自己的失效映射成 raise/clear，
 * 收口到 systemSignals 注册表。存储损坏（第五类，G127）在 runtime/storageCorruption.ts 的
 * noteCorruption 处直接接入（那里是 S01 留的唯一接入点）。
 */
import type { PlatformStatus } from '@shared/platform/message';
import { raiseSystemSignal, clearSystemSignal } from './systemSignals';

/**
 * 凭据过期（派生型，随连接态自愈）。平台状态每次变更调一次：
 * - credential-error → 凭据过期信号
 * - 其余状态 → 无系统性问题，清掉
 *
 * 注意 disconnected 不算掉线：它唯一的产生路径是「用户停用平台」（platformManager 对
 * !enabled 的上报，设置页文案即「未启用」）——停用是用户意志，不是系统性失效。真正的
 * 运行中掉线由两个平台 SDK 自带重连消化、不冒泡成状态，「渠道掉线」信号（channel-offline）
 * 因此暂无产生路径，待接入 SDK 断线冒泡后再升（台账 G137）。
 */
export function feedPlatformStatus(s: PlatformStatus): void {
  const credId = `credential-expired:${s.platform}`;
  if (s.state === 'credential-error') {
    raiseSystemSignal({
      id: credId,
      kind: 'credential-expired',
      severity: 'warning',
      params: { platform: s.platform },
      detail: s.error,
    });
  } else {
    clearSystemSignal(credId);
  }
}

/**
 * 旧撤销缺陷误删的档案仍在记忆回收站（PRD 2026-07-27 决策一）。boot 时扫描一次，命中即升
 * 单条信号（不逐文件刷屏），detail 列回收站相对路径。事件型且自愈：档案被找回 / 回收站
 * 30 天到期清理后，下次启动扫不到就不再升。
 */
export function feedTrashedProfiles(trashRelPaths: string[]): void {
  if (trashRelPaths.length === 0) return;
  raiseSystemSignal({
    id: 'trashed-profile-found',
    kind: 'trashed-profile-found',
    severity: 'warning',
    params: { count: trashRelPaths.length },
    detail: trashRelPaths.join('\n'),
  });
}

/**
 * 写盘失败（资源耗尽的可见半——产出无处落盘）。收敛为单条信号（同一次磁盘满会让多路写全败，
 * 不逐路径刷屏），detail 记最近一次失败的路径与原因。由 fs/safeWrite 的失败上报钩子驱动。
 */
export function feedWriteFailure(absPath: string, err: unknown): void {
  raiseSystemSignal({
    id: 'write-failed',
    kind: 'write-failed',
    severity: 'critical',
    detail: `${absPath}: ${err instanceof Error ? err.message : String(err)}`,
  });
}

/**
 * 文件历史里程碑到期归档（S28 · G92）——里程碑版本（手动/AI/换笔/恢复前等）超保留期不静默删，改「归档 +
 * 提示」：仍在时间轴可找回，但发一条系统信号告知。逐文件归档事件汇总成单条信号（不逐文件刷屏），count 累加
 * 本会话内归档总数。事件型：归档是一次性事件、不可再检测，重启清零（与写盘失败/损坏同族）。
 */
let archivedMilestoneCount = 0;
export function feedMilestoneArchived(count: number): void {
  if (count <= 0) return;
  archivedMilestoneCount += count;
  raiseSystemSignal({
    id: 'history-milestone-archived',
    kind: 'history-milestone-archived',
    severity: 'warning',
    params: { count: archivedMilestoneCount },
  });
}

/** 测试用：清零归档累计（避免用例间串味）。 */
export function __resetMilestoneArchivedForTest(): void {
  archivedMilestoneCount = 0;
}

/**
 * 冲突未落盘内容降级入历史可找回（S29·G90）——弃写降级（无编辑器接住在途内容）与崩溃重开残留冲突两条
 * 路径共用：都是「内容因冲突没能正常落盘，但已进历史可找回」。汇总成单条信号、count 累加本会话内总数。
 * 事件型：一次性、不可再检测，重启清零（与归档/写盘失败同族）。
 */
let conflictRecoverableCount = 0;
export function feedConflictRecoverable(count: number): void {
  if (count <= 0) return;
  conflictRecoverableCount += count;
  raiseSystemSignal({
    id: 'history-conflict-recoverable',
    kind: 'history-conflict-recoverable',
    severity: 'warning',
    params: { count: conflictRecoverableCount },
  });
}

/** 测试用：清零冲突可找回累计。 */
export function __resetConflictRecoverableForTest(): void {
  conflictRecoverableCount = 0;
}

// ─── 调度停摆看门狗 ─────────────────────────────────────────────────
// 调度器自己在跑就是健康——「停摆」只能由外部观察者判：每 tick 更新心跳，看门狗查心跳是否变陈。
// 陈旧阈值取 3× tick 间隔（容一次漏拍）；笔记本休眠会让两个定时器一起暂停、唤醒后一同恢复，
// 短暂误报在下一 tick（≤30s）即自清，可接受（好过永远发现不了真停摆）。
const STALL_MS = 90_000;
const WATCHDOG_MS = 60_000;
let watchdog: NodeJS.Timeout | null = null;

export function startSchedulerWatchdog(getHealth: () => { started: boolean; lastTickAt: number }): void {
  if (watchdog) return;
  const check = () => {
    const h = getHealth();
    if (h.started && Date.now() - h.lastTickAt > STALL_MS) {
      raiseSystemSignal({ id: 'scheduler-stalled', kind: 'scheduler-stalled', severity: 'warning' });
    } else {
      clearSystemSignal('scheduler-stalled');
    }
  };
  watchdog = setInterval(check, WATCHDOG_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();
}

export function stopSchedulerWatchdog(): void {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}
