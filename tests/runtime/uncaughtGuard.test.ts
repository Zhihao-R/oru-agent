/**
 * uncaughtException 兜底——EPIPE（对端已关闭的管道写入）记日志放行，
 * 其他错误补回 Electron 默认弹框的可见性。
 *
 * 回归测试复刻线上路径：claude-agent-sdk 的 claude 子进程关流/死亡瞬间，SDK 的
 * 在途 stdin 写入异步抛 EPIPE（stream 'error' 无监听 → uncaughtException）。
 * 两个关键设计，偏离任何一个测试都会假绿/假红：
 * - 子进程必须「关掉 stdin 读端但保持存活」——整体退出后句柄已被 destroy，
 *   写入只会拿到 ERR_STREAM_DESTROYED 或被静默吞掉，钓不出 EPIPE；
 * - guard 装在独立 node 进程里跑——vitest 自己监听 uncaughtException 上报
 *   未处理错误，进程内触发真异常会与之缠绕。
 */
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createUncaughtGuard,
  type UncaughtGuardDeps,
} from '../../electron/main/runtime/uncaughtGuard';

describe('createUncaughtGuard', () => {
  it('EPIPE 只记日志，不弹框', () => {
    const deps = { warn: vi.fn(), showErrorBox: vi.fn() } satisfies UncaughtGuardDeps;
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    createUncaughtGuard(deps)(err);
    expect(deps.warn).toHaveBeenCalledOnce();
    expect(deps.showErrorBox).not.toHaveBeenCalled();
  });

  it('非 EPIPE 记日志并弹框——userland 监听抑制了 Electron 默认框，可见性要自己补', () => {
    const deps = { warn: vi.fn(), showErrorBox: vi.fn() } satisfies UncaughtGuardDeps;
    createUncaughtGuard(deps)(new Error('boom'));
    expect(deps.warn).toHaveBeenCalledOnce();
    expect(deps.showErrorBox).toHaveBeenCalledOnce();
  });
});

describe('回归：真实异步 EPIPE 被 guard 拦下', () => {
  it('子进程关 stdin 读端后的在途写入不再炸进程', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const fixture = join(here, 'fixtures', 'epipeGuard.fixture.ts');
    const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, fixture], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
      child.on('error', reject);
    });
    // 哨兵 + 退出码双断言——EPIPE 根本没触发时退出码也是非 0 超时码，
    // 但只靠码区分不了「拦截成功」与「意外正常退出」，哨兵钉死走了 EPIPE 分支
    expect(result.out).toContain('GUARD_SUPPRESSED_EPIPE');
    expect(result.code).toBe(0);
  }, 20_000);
});
