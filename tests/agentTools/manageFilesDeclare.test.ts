/**
 * manage_files 三操作补产物申报（PRD 第 7 项·三层方案「删除/改名/移动」层）：
 * 目标路径本来就明确，成功后以 structured.fileChanges 申报事实——delete 报被删路径，
 * move/rename 报终点路径并带 from（渲染层据此把同轮旧路径条目并过来）。
 * 执行器本身（mutate 内核、撞名拒绝等）由 manageFilesMoveRename.test 覆盖，这里 mock 掉。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@shared/types';
import { readStructuredMarkers } from '@shared/agent/structuredMarkers';

const H = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/oru-test-mfdecl-${Date.now()}`;
  process.env.ORU_DIR = dir;
  return { dir };
});

const WORK = join(H.dir, 'work');

vi.mock('../../electron/main/agent/agentTools/pathSandbox', () => ({
  assertWritableSandbox: async () => {},
  SandboxError: class SandboxError extends Error {},
}));
vi.mock('../../electron/main/proposals/executeFileWriteProposal', () => ({
  executeFileWriteProposal: async () => {},
}));
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

let makeManageFilesTool!: typeof import('../../electron/main/agent/agentTools/manageFiles').makeManageFilesTool;

beforeAll(async () => {
  await fs.mkdir(join(WORK, 'sub'), { recursive: true });
  ({ makeManageFilesTool } = await import('../../electron/main/agent/agentTools/manageFiles'));
});

afterAll(async () => {
  await fs.rm(H.dir, { recursive: true, force: true });
});

let n = 0;
const tmpFile = async (): Promise<string> => {
  const p = join(WORK, `f${n++}.md`);
  await fs.writeFile(p, 'hi');
  return p;
};

const run = async (input: Record<string, unknown>) => {
  const { makeToolContext } = await import('../helpers/toolContext');
  return makeManageFilesTool().execute(input, makeToolContext({ conversationId: 'conv-mfdecl' }));
};

describe('manage_files 产物申报', () => {
  it('delete → 申报被删路径', async () => {
    const p = await tmpFile();
    const r = await run({ action: 'delete', path: p });
    expect(r.isError).toBeFalsy();
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([{ path: p, op: 'delete' }]);
  });

  it('move → 申报终点路径（destDir/原名）并带 from', async () => {
    const p = await tmpFile();
    const dest = join(WORK, 'sub');
    const r = await run({ action: 'move', path: p, destDir: dest });
    expect(r.isError).toBeFalsy();
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([
      { path: join(dest, p.split('/').pop()!), op: 'move', from: p },
    ]);
  });

  it('rename → 申报同目录新名并带 from', async () => {
    const p = await tmpFile();
    const r = await run({ action: 'rename', path: p, newName: 'renamed.md' });
    expect(r.isError).toBeFalsy();
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([
      { path: join(WORK, 'renamed.md'), op: 'rename', from: p },
    ]);
  });
});
