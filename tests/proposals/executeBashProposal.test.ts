/**
 * bash 执行器回归。
 *
 * 锁的目标问题：
 *  ① 前台命令上限放宽到 30min（原 10min）——前台阻塞对话轮，仍需上限。
 *  ② 后台命令（run_in_background）豁免固定超时——只要持续有输出，30min 后也不被杀（G107·PM 口径）。
 *  ③ 后台命令长时间无新输出 → 停滞看门狗判失败并终止进程组（G107）。
 *  ④ 后台命令退出 → 合成完成触发（G15）：注入的 completionNotifier 被调、带退出码。
 *  ⑤ killBashForConversation 主动杀的后台命令不发完成触发（用户终止 ≠ 命令完成）。
 *
 * 走 mock 的持久化 store（不落真盘）+ 可发数据的 fake child。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BashProposal } from '@shared/types';

const PID = 4242;

const h = vi.hoisted(() => {
  type FakeChild = {
    pid: number;
    stdout: { on: (ev: string, cb: (b: Buffer) => void) => void };
    stderr: { on: (ev: string, cb: (b: Buffer) => void) => void };
    unref: () => void;
    on: (ev: string, cb: (...a: unknown[]) => void) => void;
    emit: (ev: string, ...a: unknown[]) => void;
    emitStdout: (s: string) => void;
  };
  const children: FakeChild[] = [];
  function makeChild(): FakeChild {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    const dataHandlers: ((b: Buffer) => void)[] = [];
    const child: FakeChild = {
      pid: PID,
      stdout: { on: (ev, cb) => void (ev === 'data' && dataHandlers.push(cb)) },
      stderr: { on: () => {} },
      unref: () => {},
      on: (ev, cb) => void ((handlers[ev] ||= []).push(cb)),
      emit: (ev, ...a) => (handlers[ev] || []).forEach((f) => f(...a)),
      emitStdout: (s) => dataHandlers.forEach((f) => f(Buffer.from(s, 'utf-8'))),
    };
    children.push(child);
    return child;
  }
  return { children, makeChild };
});

vi.mock('node:child_process', () => ({ spawn: () => h.makeChild() }));
vi.mock('../../electron/main/proposals/tableGate', () => ({
  assertTableGate: vi.fn(async () => {}),
}));
vi.mock('../../electron/main/table/scriptOutputs', () => ({
  declaredOutputs: vi.fn(async () => [] as string[]),
}));
vi.mock('../../electron/main/agent/store/agents', () => ({
  listAgents: vi.fn(async () => ({ activeId: 'twin', agents: [] })),
}));
const storeMock = vi.hoisted(() => ({
  records: [] as Array<Record<string, unknown>>,
  patches: [] as Array<{ id: string; patch: Record<string, unknown> }>,
}));
vi.mock('../../electron/main/proposals/backgroundCommandStore', () => ({
  backgroundOutputPath: (_o: string, id: string) => `/tmp/${id}.output.txt`,
  createBackgroundCommand: vi.fn(async (rec: Record<string, unknown>) => {
    storeMock.records.push(rec);
  }),
  patchBackgroundCommand: vi.fn(async (_o: string, id: string, patch: Record<string, unknown>) => {
    storeMock.patches.push({ id, patch });
    const base = storeMock.records.find((r) => r.id === id) ?? { id };
    return { ...base, ...patch, id };
  }),
  appendBackgroundOutput: vi.fn(async () => {}),
}));
const outboundMock = vi.hoisted(() => ({ traces: [] as Array<Record<string, unknown>> }));
vi.mock('../../electron/main/platform/outboundHistory', () => ({
  recordOutbound: vi.fn(async (t: Record<string, unknown>) => {
    outboundMock.traces.push(t);
  }),
}));

import {
  runBashCommand,
  killBashForConversation,
  setBackgroundCompletionNotifier,
  __bgWatchdogTickForTest,
  BG_STALL_MS,
} from '../../electron/main/proposals/executeBashProposal';

type FakeProposal = Pick<
  BashProposal,
  'command' | 'cwd' | 'timeout' | 'runInBackground' | 'conversationId' | 'ownerId' | 'id' | 'delivery'
>;
function proposal(over: Partial<FakeProposal>): BashProposal {
  return {
    id: 'p1',
    command: 'sleep 9999',
    cwd: '/tmp',
    conversationId: 'conv1',
    ownerId: 'local-user',
    ...over,
  } satisfies FakeProposal as unknown as BashProposal;
}

let killSpy: ReturnType<typeof vi.spyOn>;
let completions: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.useFakeTimers();
  h.children.length = 0;
  storeMock.records.length = 0;
  storeMock.patches.length = 0;
  outboundMock.traces.length = 0;
  completions = [];
  setBackgroundCompletionNotifier((rec) => completions.push(rec));
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  killSpy.mockRestore();
  setBackgroundCompletionNotifier(null);
});

function killedGroup(): boolean {
  return killSpy.mock.calls.some(([pid]) => pid === -PID);
}

describe('runBashCommand 超时', () => {
  it('前台命令上限 30min：10min 未到上限不杀，30min 杀', async () => {
    void runBashCommand(proposal({ timeout: 40 * 60 * 1000 })).catch(() => {});
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 5000);
    expect(killedGroup()).toBe(false);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(2000);
  });
});

describe('外发出口加固（S26 G75）', () => {
  it('外发命令（delivery 非空）：输出脱敏 + 框「读到的材料」 + 每目标记一条本地痕迹', async () => {
    const p = runBashCommand(
      proposal({
        command: 'lark-cli im message create ...',
        conversationId: 'conv-out',
        ownerId: 'owner-x',
        delivery: [{ channel: 'feishu', recipient: 'oc_group1', label: 'lark-cli …' }],
      }),
    );
    await vi.advanceTimersByTimeAsync(0); // 过掉 assertTableGate/declaredOutputs 的 await，spawn 发生
    const child = h.children[0];
    child.emitStdout('发送成功 token: sk-abcdefghijklmnop1234\n发给群 oc_group1\n');
    child.emit('close', 0);
    const { inlineText } = await p;
    // 脱敏：密钥被打码、原文不外泄给模型
    expect(inlineText).toContain('***');
    expect(inlineText).not.toContain('sk-abcdefghijklmnop1234');
    // 来源分级框（G76 对命令输出同样生效）
    expect(inlineText).toContain('读到的材料');
    // 本地痕迹：渠道 + 收件人 + 来源对话 + via=command
    expect(outboundMock.traces).toHaveLength(1);
    expect(outboundMock.traces[0]).toMatchObject({
      ownerId: 'owner-x',
      channel: 'feishu',
      recipient: 'oc_group1',
      conversationId: 'conv-out',
      via: 'command',
    });
  });

  it('非外发命令（无 delivery）：不记痕迹、不脱敏（普通输出原样回模型）', async () => {
    const p = runBashCommand(proposal({ command: 'echo hi', conversationId: 'conv-plain' }));
    await vi.advanceTimersByTimeAsync(0);
    const child = h.children[0];
    child.emitStdout('sk-abcdefghijklmnop1234\n'); // 普通命令输出里的疑似密钥不被本闸脱敏
    child.emit('close', 0);
    const { inlineText } = await p;
    expect(outboundMock.traces).toHaveLength(0);
    expect(inlineText).toContain('sk-abcdefghijklmnop1234'); // 非外发不脱敏（G75 只收口外发出口）
    expect(inlineText).toContain('读到的材料'); // 但来源分级框对所有命令输出生效（G76）
  });
});

describe('后台命令（G15/G107）', () => {
  it('持续有输出：30min 后不被固定超时或看门狗杀', async () => {
    await runBashCommand(proposal({ runInBackground: true, id: 'bgA' }));
    const child = h.children[0];
    // 每 5min 冒一段输出——刷新 lastOutputAt，看门狗不判停滞
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      child.emitStdout(`progress ${i}\n`);
    }
    expect(killedGroup()).toBe(false);
    expect(completions).toHaveLength(0); // 还在跑，没触发完成
  });

  it('长时间无新输出：看门狗判停滞、杀进程组、发失败完成触发', async () => {
    await runBashCommand(proposal({ runInBackground: true, id: 'bgStall' }));
    await vi.advanceTimersByTimeAsync(BG_STALL_MS + 60 * 1000); // 越过停滞窗
    __bgWatchdogTickForTest(); // 显式驱动一次（不依赖 interval 在 fake timer 下的行为）
    await vi.advanceTimersByTimeAsync(10);
    expect(killedGroup()).toBe(true);
    expect(completions).toHaveLength(1);
    expect(completions[0].timedOut).toBe(true);
  });

  it('进程自行退出：合成完成触发、带退出码', async () => {
    await runBashCommand(proposal({ runInBackground: true, id: 'bgDone', conversationId: 'conv-done' }));
    h.children[0].emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(completions).toHaveLength(1);
    expect(completions[0].exitCode).toBe(0);
    expect(completions[0].status).toBe('exited');
  });

  it('派工 subagent 内的后台命令（task_ 前缀）：完成不进主队列', async () => {
    await runBashCommand(
      proposal({ runInBackground: true, id: 'bgSub', conversationId: 'task_abc' }),
    );
    h.children[0].emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(completions).toHaveLength(0);
  });

  it('killBashForConversation 主动杀：不发完成触发（用户终止 ≠ 命令完成）', async () => {
    await runBashCommand(
      proposal({ runInBackground: true, id: 'bgKill', conversationId: 'conv-kill' }),
    );
    killBashForConversation('conv-kill');
    expect(killSpy).toHaveBeenCalledWith(-PID, 'SIGTERM');
    h.children[0].emit('close', null); // 被杀后进程退出
    await vi.advanceTimersByTimeAsync(3000);
    expect(completions).toHaveLength(0);
    // SIGKILL 兜底应被取消（进程已在宽限内退出）
    const sigkills = killSpy.mock.calls.filter(([pid, sig]) => pid === -PID && sig === 'SIGKILL');
    expect(sigkills).toHaveLength(0);
  });
});
