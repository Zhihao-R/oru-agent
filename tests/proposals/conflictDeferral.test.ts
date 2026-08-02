/**
 * S29·G90③ AI 后续写入的并行 defer：目标文件正开着冲突卡时，AI 的 create/overwrite/edit 一律挂起
 * （不落盘、记一笔挂起来自本对话、抛「已挂起」交回 AI），裁决撤登记后放行。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileWriteProposal } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-conflictdefer-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const WORK = join(ORU_DIR, 'work');

let executeFileWriteProposal!: typeof import('../../electron/main/proposals/executeFileWriteProposal').executeFileWriteProposal;
let CR!: typeof import('../../electron/main/fs/conflictRegistry');

let seq = 0;
function freshFile(): string {
  return join(WORK, `f-${seq++}.md`);
}

beforeAll(async () => {
  await fs.mkdir(WORK, { recursive: true });
  ({ executeFileWriteProposal } = await import('../../electron/main/proposals/executeFileWriteProposal'));
  CR = await import('../../electron/main/fs/conflictRegistry');
});
beforeEach(() => CR.__resetConflictRegistryForTest());
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

function createProposal(path: string, content: string): FileWriteProposal {
  return {
    kind: 'file.write',
    status: 'pending',
    id: `prop-${Math.random().toString(36).slice(2)}`,
    ownerId: 'owner-1',
    conversationId: 'conv-defer',
    title: 'create',
    description: 'create',
    createdAt: 0,
    path,
    mode: 'create',
    forceApproval: false,
    content,
  };
}

describe('S29·G90③ 冲突未决期 AI 写入并行 defer', () => {
  it('开着冲突卡时 AI 写入被挂起：抛「已挂起」、磁盘一字未落、记一笔挂起', async () => {
    const p = freshFile();
    CR.markConflictOpen(p);
    await expect(executeFileWriteProposal(createProposal(p, 'ai-new'))).rejects.toThrow();
    expect(existsSync(p)).toBe(false); // 磁盘一字未落
    // 挂起来自本对话被记账：裁决时取回
    expect(CR.clearConflict(resolve(p))).toContain('conv-defer');
  });

  it('裁决撤登记后同一写入放行、正常落盘', async () => {
    const p = freshFile();
    CR.markConflictOpen(p);
    await expect(executeFileWriteProposal(createProposal(p, 'x'))).rejects.toThrow();
    CR.clearConflict(p); // 用户裁决收起
    await executeFileWriteProposal(createProposal(p, 'ai-new'));
    expect(await fs.readFile(p, 'utf-8')).toBe('ai-new');
  });
});
