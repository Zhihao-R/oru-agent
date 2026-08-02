/**
 * 系统例行统一调度内核（G44）。
 *
 * 各项后台节律（自动归档、回收站清除…）此前各自手写同一套纪律：启停成对、执行防重入（上一轮没跑完
 * 不叠加下一轮）、开机先补一次停机期间错过的窗口。三件事与「多久跑一次」正交，故沉淀到这里——例行
 * 只声明「节律（interval/daily）＋做什么（run）＋要不要开机补跑（runOnStart）」，三纪律由内核保证。
 *
 * 谁用它：autoArchiver（interval 扫描）、trashCleaner（daily 清除）。谁**不**用（本质额外结构，内核
 * 的简单声明模型装不下，硬迁反招回归，故保留 bespoke）：dreamScheduler（每日 + 20 条阈值 + 30s 去抖
 * 复合触发、磁盘 lastDreamAt 早触发免疫）、scheduledTasks/scheduler（逐任务投递账 + 到点宽限 + 时区锚）。
 */

/** 触发节律：固定间隔轮询，或每天某个本地整点。 */
export type RoutineTrigger =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; hour: number }; // 本地时间 hour:00

export type SystemRoutineSpec = {
  /** 日志/诊断用标识。 */
  id: string;
  trigger: RoutineTrigger;
  /** 每次触发要做的事。防重入由内核保证——上一轮未 resolve 时的触发直接跳过。 */
  run: () => Promise<void>;
  /**
   * 启动即先跑一轮（幂等例行的顺手整理，覆盖停机期间攒下的活）。多数例行为 true、缺省 false。
   * 注意：只是「立刻跑一次」，不读「上次何时跑过」——真正按窗口判漏跑要持久化 lastRun
   * （那是 dream 用 lastDreamAt 做的事、本内核不做，故这些例行的 run 必须幂等）。
   */
  runOnStart?: boolean;
};

export type SystemRoutine = {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /**
   * 手动催一轮（活跃驱动，G27）——除定时节律外，由外部事件（如回合收尾）顺带触发一次 run。
   * 走同一防重入门：与飞行中的定时轮重叠时直接跳过。fire-and-forget，不 await。
   */
  trigger(): void;
};

/** 距离下一个本地 hour:00 的毫秒数（≤0 不会出现：同一整点算作明天）。导出供单测。 */
export function msUntilHour(now: number, hour: number): number {
  const n = new Date(now);
  const next = new Date(n.getFullYear(), n.getMonth(), n.getDate(), hour, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now;
}

export function createSystemRoutine(spec: SystemRoutineSpec): SystemRoutine {
  let dispose: (() => void) | null = null;
  let inflight = false;

  // 防重入：上一轮没跑完，这一拍直接跳过（对齐既有 scanInflight/tickInflight 语义）。
  const guardedRun = async (): Promise<void> => {
    if (inflight) return;
    inflight = true;
    try {
      await spec.run();
    } catch (e) {
      console.warn(`[systemRoutine:${spec.id}] tick 异常（吞掉不阻断后续）`, e);
    } finally {
      inflight = false;
    }
  };

  return {
    start() {
      if (dispose) return; // 幂等：已在跑
      if (spec.trigger.kind === 'interval') {
        const h = setInterval(() => void guardedRun(), spec.trigger.everyMs);
        if (typeof h.unref === 'function') h.unref();
        dispose = () => clearInterval(h);
      } else {
        // daily：setTimeout 到下一个整点，触发后重排下一天（不用 setInterval——跨 DST/长睡更稳）。
        const { hour } = spec.trigger;
        let handle: ReturnType<typeof setTimeout>;
        let stopped = false;
        const arm = () => {
          handle = setTimeout(
            () => {
              void guardedRun();
              if (!stopped) arm();
            },
            msUntilHour(Date.now(), hour),
          );
          if (typeof handle.unref === 'function') handle.unref();
        };
        arm();
        dispose = () => {
          stopped = true;
          clearTimeout(handle);
        };
      }
      // 开机即跑放在装好定时器之后：即便 run 同步抛，周期定时器已就位、不至于漏排。
      if (spec.runOnStart) void guardedRun();
    },
    stop() {
      dispose?.();
      dispose = null;
      // 不重置 inflight：飞行中的 run 由它自己的 finally 清；此处强清会谎称「没在跑」，
      // 若紧接着 start() 会让新一拍与飞行中的旧 run 并行（防重入形同虚设）。
    },
    isRunning() {
      return dispose !== null;
    },
    trigger() {
      void guardedRun();
    },
  };
}
