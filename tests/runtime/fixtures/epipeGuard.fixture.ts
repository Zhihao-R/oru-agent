/**
 * 在独立 node 进程里复刻线上 EPIPE 路径（设计取舍见 ../uncaughtGuard.test.ts 头注释）。
 * 退出码：0 = guard 拦下 EPIPE；3 = 误走弹框分支；1 = 超时没钓出 EPIPE。
 */
import { spawn } from 'node:child_process';
import { createUncaughtGuard } from '../../../electron/main/runtime/uncaughtGuard';

// 子进程关掉自己的 stdin 读端但保持存活——这是钓出 EPIPE（而非 ERR_STREAM_DESTROYED）的关键
const child = spawn(
  process.execPath,
  ['-e', 'require("node:fs").closeSync(0); setInterval(() => {}, 1000)'],
  { stdio: ['pipe', 'ignore', 'ignore'] },
);

// 各分支 process.exit 直接终结事件循环，定时器无需也不必清理
setTimeout(() => {
  child.kill();
  process.exit(1);
}, 15_000);

process.on(
  'uncaughtException',
  createUncaughtGuard({
    // handler 两条分支都会先过 warn——必须核 err.code 才认账，否则非 EPIPE
    // 错误（如 ERR_STREAM_DESTROYED）也会抢跑打哨兵，测试假绿。
    // 非 EPIPE 时不退出，放行给 showErrorBox 分支落到退出码 3。
    warn: (_message, err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') return;
      console.log('GUARD_SUPPRESSED_EPIPE');
      child.kill();
      process.exit(0);
    },
    showErrorBox: () => {
      child.kill();
      process.exit(3);
    },
  }),
);

// 读端关闭后持续写，直到内核管道层吐出异步 EPIPE。
// child.stdin 故意不挂 'error' 监听——与 SDK 现状一致，让错误走 uncaughtException
setInterval(() => {
  child.stdin.write('x'.repeat(65536));
}, 20);
