/**
 * 主进程 uncaughtException 兜底（index.ts 模块顶层接线，仿 beforeQuit.ts 的 deps 注入）。
 *
 * 背景：claude-agent-sdk 不给 claude 子进程的 stdin 挂 'error' 监听，子进程死亡/关流
 * 瞬间的在途写入会异步抛 EPIPE（SDK 对 write 的 try/catch 只捕同步错误），无监听的
 * stream 'error' 升级成 uncaughtException，Electron 默认行为是弹系统错误对话框吓用户。
 * ws 连接同理（server.ts 已挂监听兜第一层），这里统一接住一切「对端先关」的管道写失败。
 *
 * 为什么不在源头修：SDK 有 spawnClaudeCodeProcess 钩子可自己 spawn 子进程并挂监听，
 * 但它不在 sdk.d.ts 公开类型里，且自定义 spawn 会绕过 SDK 内部的 stderr 接线
 * （claudeAgentSdk.ts 的崩溃诊断依赖 opts.stderr），SDK 升级随时静默漂移——不值得。
 *
 * 非 EPIPE 错误弹框后不退出——与 Electron 默认处理器语义一致（它本身就不退）；
 * 注册 userland 监听后默认弹框被抑制，可见性必须自己补回，否则真 bug 从弹框降级成只进 console。
 */
export type UncaughtGuardDeps = {
  warn: (message: string, err: Error) => void;
  /** 非 EPIPE 时补回 Electron 默认弹框（注册 userland 监听后默认框被抑制） */
  showErrorBox: (title: string, content: string) => void;
};

export function createUncaughtGuard(deps: UncaughtGuardDeps): (err: Error) => void {
  return (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
      deps.warn('[oru.uncaught] 忽略 EPIPE（对端已关闭的管道写入）：', err);
      return;
    }
    deps.warn('[oru.uncaught] 未捕获异常：', err);
    // 与 Electron 默认处理器同文案同语义
    deps.showErrorBox(
      'A JavaScript error occurred in the main process',
      `Uncaught Exception:\n${err.stack ?? String(err)}`,
    );
  };
}
