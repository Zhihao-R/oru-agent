/**
 * runLarkCli 超时终止回归（2026-07-03 审计 major#2）。
 *
 * 目标问题：默认走 `npx @larksuite/cli@latest` 时真 CLI 是 npx 的孙进程——超时只
 * SIGKILL 直接子进程会把挂死的 lark-cli 留成孤儿，每超时泄漏一个 node 进程。
 * 修法与 executeBashProposal 同构：spawn detached（子进程成进程组组长）+ 超时 kill(-pid) 杀整组。
 *
 * 测试用真实进程复现 npx 型父子结构：node -e 父进程再 spawn 一个挂住的孙进程后自己也挂住，
 * 触发超时后断言孙进程也被终止（修复前只死父进程，孙进程存活 → 红）。
 */
import { describe, it, expect, afterEach } from 'vitest';

// 父进程脚本：spawn 挂住的孙进程（stdio ignore——否则孙进程握着 stdout 管道，父进程被杀后
// close 事件迟迟不来）、吐出孙进程 pid、然后自己挂住等超时。
// 父与孙都用 30s 有限挂住（而非无限 setInterval）：若修复回归到杀不死整组，afterEach 兜底
// 可能拿不到 pid（runLarkCli 永不 resolve），有限时长保证失败路径也不给测试机留永久孤儿。
const HANG_30S = 'setTimeout(() => process.exit(1), 30_000)';
const PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", ${JSON.stringify(HANG_30S)}], { stdio: "ignore" });
console.log("GRANDCHILD_PID=" + g.pid);
${HANG_30S};
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 只探活不发信号
    return true;
  } catch {
    return false;
  }
}

/** 轮询等进程死透（SIGKILL 送达与回收有微小延迟），超 ms 仍活着返回 false。 */
async function waitDead(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

let grandchildPid: number | undefined;

afterEach(() => {
  // 断言失败（孙进程成孤儿）时兜底清理，不给测试机留泄漏进程
  if (grandchildPid && isAlive(grandchildPid)) {
    try {
      process.kill(grandchildPid, 'SIGKILL');
    } catch {
      // 已死——忽略
    }
  }
  grandchildPid = undefined;
  delete process.env.ORU_LARK_CLI_BIN;
});

describe('runLarkCli 超时', () => {
  it(
    '超时终止整个进程组：npx 型孙进程不成孤儿',
    async () => {
      // SPAWN_BASE 在模块加载时读 env——显式设好再动态 import，不依赖默认 npx 路径
      process.env.ORU_LARK_CLI_BIN = process.execPath;
      const { runLarkCli } = await import('../../electron/main/platform/feishuCli');

      const result = await runLarkCli(['-e', PARENT_SCRIPT], { timeoutMs: 800 });

      const m = result.stdout.match(/GRANDCHILD_PID=(\d+)/);
      expect(m, '父进程应在超时前吐出孙进程 pid').toBeTruthy();
      grandchildPid = Number(m![1]);

      expect(result.exitCode).toBeNull(); // 被信号杀掉，非正常退出
      expect(await waitDead(grandchildPid, 2000), '孙进程应随进程组一起被终止').toBe(true);
    },
    15000,
  );
});
