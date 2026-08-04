/**
 * bash 预期申报接线（PRD 第 7 项）：expected_files 随命令申报，执行后核验、核实变动的
 * 作为 structured.fileChanges 事实标记回渲染层。
 *
 * 承重的三条：
 *   ① 核实变动的进标记、申报了没动的不进（误报被核验消掉）；
 *   ② 命令失败（exitCode≠0）不附标记——与读端「isError 不采信」同一闸口，不留死数据；
 *   ③ 后台命令返回时还没跑完、无从核验——只带 backgroundCommand 标记，不带 fileChanges。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@shared/types';
import { readStructuredMarkers } from '@shared/agent/structuredMarkers';

const H = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/oru-test-bashexp-${Date.now()}`;
  process.env.ORU_DIR = dir;
  return { dir };
});

const WORK = join(H.dir, 'work');

vi.mock('../../electron/main/agent/agentTools/pathSandbox', () => ({
  assertWritableSandbox: async () => {},
  defaultSearchRoot: async () => WORK,
  SandboxError: class SandboxError extends Error {},
}));
vi.mock('../../electron/main/proposals/tableGate', () => ({ assertTableGate: async () => {} }));
vi.mock('../../electron/main/agent/store/agents', () => ({
  getAgent: async (id: string): Promise<Agent> => ({
    id,
    ownerId: 'local-user',
    name: 'Oru',
    homePath: '/tmp/h',
    systemPromptAppend: null,
    approvalMode: 'danger',
    createdAt: 0,
    avatarPath: null,
  }),
  realtimeApprovalModeFor: async (): Promise<Agent['approvalMode']> => 'danger',
}));

let makeBashTool!: typeof import('../../electron/main/agent/agentTools/bash').makeBashTool;
let killBashForConversation!: typeof import('../../electron/main/proposals/executeBashProposal').killBashForConversation;

beforeAll(async () => {
  await fs.mkdir(WORK, { recursive: true });
  ({ makeBashTool } = await import('../../electron/main/agent/agentTools/bash'));
  ({ killBashForConversation } = await import('../../electron/main/proposals/executeBashProposal'));
});

afterAll(async () => {
  killBashForConversation('conv-bashexp');
  // bash 工具的子进程/异步落盘可能在 kill 后仍短暂写入（`rm` 与重建竞态 → ENOTEMPTY，见
  // manageFilesMoveRename：等异步落盘清空再 rm）。退避重试，避免 CI 并行下偶发清理失败。
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rm(H.dir, { recursive: true, force: true });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && i === 4) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

const run = async (input: Record<string, unknown>) => {
  const { makeToolContext } = await import('../helpers/toolContext');
  return makeBashTool().execute(input, makeToolContext({ conversationId: 'conv-bashexp' }));
};

describe('bash expected_files 申报与核验', () => {
  it('核实变动的进 fileChanges（相对路径按 cwd 解析），申报了没动的不进', async () => {
    const r = await run({
      command: 'printf hi > made.txt',
      expected_files: ['made.txt', 'untouched.txt'],
    });
    expect(r.isError).toBeFalsy();
    expect(readFileSync(join(WORK, 'made.txt'), 'utf-8')).toBe('hi');
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([{ path: join(WORK, 'made.txt'), op: 'create' }]);
  });

  it('没申报就没有标记（漏报是接受的残余风险，不做目录比对兜底）', async () => {
    const r = await run({ command: 'printf hi > silent.txt' });
    expect(r.isError).toBeFalsy();
    expect(readStructuredMarkers(r.structured).fileChanges).toBeUndefined();
  });

  it('命令失败不附标记，即使申报的文件确实动了', async () => {
    const r = await run({
      command: 'printf x > half.txt; exit 1',
      expected_files: ['half.txt'],
    });
    expect(r.isError).toBe(true);
    expect(readStructuredMarkers(r.structured).fileChanges).toBeUndefined();
  });

  it('前台命令被取消（abort，exitCode=null）→ 判 failed、不附标记，即使申报的文件在取消前已写出', async () => {
    const ac = new AbortController();
    const { makeToolContext } = await import('../helpers/toolContext');
    const pending = makeBashTool().execute(
      { command: 'printf x > early.txt; sleep 5', expected_files: ['early.txt'] },
      makeToolContext({ conversationId: 'conv-bashexp', abortSignal: ac.signal }),
    );
    await new Promise((r) => setTimeout(r, 500)); // 等 early.txt 落盘、命令进入 sleep
    ac.abort();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(readStructuredMarkers(r.structured).fileChanges).toBeUndefined();
  });

  it('后台命令只带 backgroundCommand 标记，不带 fileChanges（返回时没跑完、无从核验）', async () => {
    const r = await run({
      command: 'sleep 0.2',
      run_in_background: true,
      expected_files: ['bg.txt'],
    });
    expect(r.isError).toBeFalsy();
    expect(readStructuredMarkers(r.structured).backgroundCommand?.id).toBeTruthy();
    expect(readStructuredMarkers(r.structured).fileChanges).toBeUndefined();
  });
});
