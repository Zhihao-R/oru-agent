/**
 * 「对话中阻止休眠」后台守门人（技术设计 docs/tech/2026-08-02-keep-awake-tech-design.md）。
 *
 * 用 macOS 原生 caffeinate 子进程顶住系统休眠/显示器息屏。多个信号源（主对话回合在跑 +
 * 后台 subagent 任务在跑）可能同时活跃，用**整数引用计数**统一管生死：任何信号在跑 refCount>0
 * 即 spawn 起来常驻，只有「最后一个信号释放」才 kill——不会反复起停、也不误杀仍在跑的。
 *
 * 平台：仅 darwin 真正 spawn caffeinate；其余平台全部 no-op（Oru 跨平台时 Windows 需另换
 * SetThreadExecutionState，本设计不覆盖）。生命周期严格跟活跃度对应，不能残留成"永远顶住"。
 */
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 平台守卫：darwin 之外整模块 no-op。读取时机放调用时（非模块加载时），
 * 让测试能通过 stub process.platform 覆盖两个分支（技术设计 §8 平台守卫）。
 */
function isDarwin(): boolean {
  return process.platform === 'darwin';
}

/** 总开关（设置项「对话中阻止休眠」驱动）。关时即使还有任务在跑也即刻松手（用户说了算）。 */
let enabled = false;
/** 活跃信号计数：主回合 + 后台任务累加。0→1 拉起、1→0 杀掉。 */
let refCount = 0;
/** 当前 caffeinate 子进程；null = 未拉起。 */
let child: ChildProcess | null = null;

/** 关总开关时计数立即归零（之后任务的 release 因 clamp 不会减成负）。 */
let forceOff = false;

/** 拉起来之前 refCount 是否已顶到 enabled 判定——re-enable 时按此刻 refCount 决定要不要补 spawn。 */
function syncProcess(): void {
  const shouldRun = enabled && refCount > 0 && !forceOff;
  if (shouldRun && !child) {
    child = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    child.once('exit', () => {
      // 进程自己退了（异常），清句柄避免下次 1→0 时 kill 已死进程报错
      if (child) child = null;
    });
  } else if (!shouldRun && child) {
    child.kill();
    child = null;
  }
}

/**
 * 一个信号源「开始干活」：引用计数 +1，0→1 则拉起 caffeinate。
 * 仅在真占住时调用（与 isConversationBusy 语义对齐，避免误计数）。
 */
export function acquire(): void {
  if (!isDarwin()) return;
  refCount += 1;
  syncProcess();
}

/**
 * 一个信号源「干完」：引用计数 -1（clamp 到 0），1→0 则杀掉 caffeinate。
 * 只挂在每个信号源恰好一次的释放点（见 subagentRunner runTask finally），
 * 不能挂在 activeTasks.delete 散点上——cancel + finally 双删会双扣计数。
 */
export function release(): void {
  if (!isDarwin()) return;
  refCount = Math.max(0, refCount - 1);
  syncProcess();
}

/**
 * 总开关（设置项驱动）。on=true 打开；on=false 即刻 kill caffeinate，即使还有任务在跑也恢复
 * 系统休眠（用户明确要停）。refCount 继续累加跟踪「仍在跑的信号」——那些信号的 release() 靠
 * clamp 不会把计数减成负、也不会误拉崩别的信号；re-enable 时若 refCount>0 会按仍需顶住补 spawn。
 */
export function setEnabled(on: boolean): void {
  if (!isDarwin()) {
    // 非 darwin 也记录总开关口径（无副作用），保持语义一致
    enabled = on;
    forceOff = !on;
    return;
  }
  if (on) {
    forceOff = false;
  } else {
    forceOff = true; // 关开关即松手：syncProcess 见 forceOff 即时 kill（refCount 保留，release clamp 兜底）
  }
  enabled = on;
  syncProcess();
}

/** 可测试读取：当前是否 caffeinate 在跑（测试断言用，非生产路径）。 */
export function isAwakeActive(): boolean {
  return child !== null;
}

/** 退出清理（before-quit）：杀残留 caffeinate，避免孤儿进程让系统一直醒着。 */
export function disposeKeepAwake(): void {
  if (child) {
    child.kill();
    child = null;
  }
  refCount = 0;
  enabled = false;
  forceOff = false;
}
