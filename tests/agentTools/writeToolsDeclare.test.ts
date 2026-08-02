/**
 * 「直接写改文件」层迁到统一 fileChanges 标记（PRD 第 7 项）：write_file / edit_file 成功后
 * 以 structured.fileChanges 申报（新建 create、改动 modify），旧 file 形状不再产出——
 * 读端对历史消息的兼容由 toolFileTargets 测试覆盖，这里锁死写端形状。
 * append_file / convert_csv_encoding 的同形改动由各自测试文件加断言。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@shared/types';
import { readStructuredMarkers } from '@shared/agent/structuredMarkers';

const H = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/oru-test-wtdecl-${Date.now()}`;
  process.env.ORU_DIR = dir;
  return { dir };
});

const WORK = join(H.dir, 'work');

vi.mock('../../electron/main/agent/agentTools/pathSandbox', () => ({
  assertWritableSandbox: async () => {},
  SandboxError: class SandboxError extends Error {},
}));
vi.mock('../../electron/main/fs/fsChanged', () => ({ broadcastFileChanged: async () => {} }));
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

let makeWriteFileTool!: typeof import('../../electron/main/agent/agentTools/writeFile').makeWriteFileTool;
let makeEditFileTool!: typeof import('../../electron/main/agent/agentTools/editFile').makeEditFileTool;
let recordRead!: typeof import('../../electron/main/agent/conversationFileState').recordRead;

beforeAll(async () => {
  await fs.mkdir(WORK, { recursive: true });
  ({ makeWriteFileTool } = await import('../../electron/main/agent/agentTools/writeFile'));
  ({ makeEditFileTool } = await import('../../electron/main/agent/agentTools/editFile'));
  ({ recordRead } = await import('../../electron/main/agent/conversationFileState'));
});

afterAll(async () => {
  await fs.rm(H.dir, { recursive: true, force: true });
});

const ctx = async () => {
  const { makeToolContext } = await import('../helpers/toolContext');
  return makeToolContext({ conversationId: 'conv-wtdecl' });
};

/** 让守卫认为本对话已整读过该文件（内容与磁盘一致） */
const markRead = (path: string, content: string) => {
  recordRead('conv-wtdecl', path, { mtime: 0, content, isPartialView: false });
};

describe('write_file / edit_file 的 fileChanges 申报', () => {
  it('write_file 新建 → create', async () => {
    const p = join(WORK, 'new.md');
    const r = await makeWriteFileTool().execute({ path: p, content: 'hi' }, await ctx());
    expect(r.isError).toBeFalsy();
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([{ path: p, op: 'create' }]);
  });

  it('write_file 覆盖已读文件 → modify', async () => {
    const p = join(WORK, 'over.md');
    await fs.writeFile(p, 'v1\n');
    markRead(p, 'v1\n');
    const r = await makeWriteFileTool().execute({ path: p, content: 'v2\n' }, await ctx());
    expect(r.isError).toBeFalsy();
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([{ path: p, op: 'modify' }]);
  });

  it('edit_file 改一处 → modify', async () => {
    const p = join(WORK, 'edit.md');
    await fs.writeFile(p, 'hello world\n');
    markRead(p, 'hello world\n');
    const r = await makeEditFileTool().execute(
      { path: p, old_string: 'world', new_string: 'oru' },
      await ctx(),
    );
    expect(r.isError).toBeFalsy();
    expect(readStructuredMarkers(r.structured).fileChanges).toEqual([{ path: p, op: 'modify' }]);
  });
});
