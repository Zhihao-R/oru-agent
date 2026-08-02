/**
 * S02 · G89：「仍恰好一处」的锁内重验。
 *
 * 守卫二（工具 emit 时数唯一）在锁外，审批窗口（分钟级）内用户可能在别处粘贴出第二处
 * 相同原文——锁内数到的才作数（理想页 G3）。本组测执行器 apply 闭包里的重验：
 * 命中 ≠ 1 且非 replaceAll → 拒绝且不落盘；replaceAll 不受唯一性限制。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileWriteProposal } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-g89-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const WORK = join(ORU_DIR, 'work');

let executeFileWriteProposal!: typeof import('../../electron/main/proposals/executeFileWriteProposal').executeFileWriteProposal;
let recordRead!: typeof import('../../electron/main/agent/conversationFileState').recordRead;

beforeAll(async () => {
  await fs.mkdir(WORK, { recursive: true });
  ({ executeFileWriteProposal } = await import('../../electron/main/proposals/executeFileWriteProposal'));
  ({ recordRead } = await import('../../electron/main/agent/conversationFileState'));
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

function editProposal(path: string, oldString: string, newString: string, replaceAll = false): FileWriteProposal {
  return {
    kind: 'file.write',
    status: 'pending',
    id: `prop-${Math.random().toString(36).slice(2)}`,
    ownerId: 'owner-1',
    conversationId: 'conv-g89',
    title: 'edit',
    description: 'edit',
    createdAt: 0,
    path,
    mode: 'edit',
    forceApproval: false,
    oldString,
    newString,
    replaceAll,
  };
}

async function readAndRecord(path: string, content: string): Promise<void> {
  await fs.writeFile(path, content);
  const { statSync } = await import('node:fs');
  recordRead('conv-g89', path, {
    mtime: Math.floor(statSync(path).mtimeMs),
    content,
    isPartialView: false,
  });
}

describe('G89 锁内重验「仍恰好一处」', () => {
  it('emit 后出现第二处相同原文 → 拒绝且一字不落盘', async () => {
    const p = join(WORK, 'dup.md');
    // AI 读时只有一处 TARGET —— emit 时守卫二通过
    await readAndRecord(p, '开头\nTARGET\n结尾\n');
    // 审批窗口内用户粘贴出第二处
    await fs.writeFile(p, '开头\nTARGET\n结尾\nTARGET\n');

    await expect(executeFileWriteProposal(editProposal(p, 'TARGET', 'REPLACED'))).rejects.toThrow(/2 处|2 times/);
    expect(await fs.readFile(p, 'utf-8')).toBe('开头\nTARGET\n结尾\nTARGET\n');
  });

  it('replaceAll 显式全替不受唯一性限制', async () => {
    const p = join(WORK, 'all.md');
    await readAndRecord(p, 'X\nX\n');
    const done = await executeFileWriteProposal(editProposal(p, 'X', 'Y', true));
    expect(done).toBeUndefined();
    expect(await fs.readFile(p, 'utf-8')).toBe('Y\nY\n');
  });

  it('恰好一处 → 正常替换落盘', async () => {
    const p = join(WORK, 'one.md');
    await readAndRecord(p, 'a\nUNIQ\nb\n');
    await executeFileWriteProposal(editProposal(p, 'UNIQ', 'DONE'));
    expect(await fs.readFile(p, 'utf-8')).toBe('a\nDONE\nb\n');
  });
});

describe('S02 review 修正回归', () => {
  it('M2：overwrite 提案在审批窗口内目标被删 → 拒绝退回，不静默复活文件', async () => {
    const p = join(WORK, 'resurrect.md');
    await readAndRecord(p, '用户后来删掉的内容');
    await fs.rm(p); // 审批窗口内用户删除
    const prop: FileWriteProposal = {
      ...editProposal(p, '', ''),
      mode: 'overwrite',
      content: 'AI 基于旧认知的覆盖',
      oldString: undefined,
      newString: undefined,
    };
    await expect(executeFileWriteProposal(prop)).rejects.toThrow();
    expect(await fs.stat(p).catch(() => null)).toBeNull(); // 文件不被复活
  });

  it('M1：锁内拒绝计入 recovery 计数（下次工具预检按累计次数触发暂停）', async () => {
    const { recordTargetMoved, resetTargetMoved } = await import(
      '../../electron/main/agent/conversationFileState'
    );
    const p = join(WORK, 'count.md');
    await readAndRecord(p, 'A\nTARGET\nB\n');
    await fs.writeFile(p, 'A\nTARGET\nB\nTARGET\n'); // 出现第二处 → 锁内 not-unique
    await expect(executeFileWriteProposal(editProposal(p, 'TARGET', 'X'))).rejects.toThrow();
    // 锁内拒绝已记 1 次：再手记一次应返回 2（证明执行器侧计入了同一计数器）
    expect(recordTargetMoved('conv-g89', p)).toBe(2);
    resetTargetMoved('conv-g89', p);
  });
});
