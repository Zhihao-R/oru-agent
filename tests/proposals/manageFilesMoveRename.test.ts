/**
 * S32·G49 manage_files 补 move/rename：执行器经项目相对 mutate 内核落地——移动/重命名成功、撞名拒绝、
 * 跨项目/项目外拒绝。复用 moveEntry/renameEntry（.md+.assets 联动、历史迁移已由 mutate 自己的测试覆盖），
 * 这里验执行器分支：项目反查 + 相对路径计算 + 结果映射。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileWriteProposal } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-mvrn-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const PROJECT = join(ORU_DIR, 'proj');

let executeFileWriteProposal!: typeof import('../../electron/main/proposals/executeFileWriteProposal').executeFileWriteProposal;
let addProject!: typeof import('../../electron/main/projects/store').addProject;
let CR!: typeof import('../../electron/main/fs/conflictRegistry');

let seq = 0;
function fresh(name: string): string {
  return join(PROJECT, `${name}-${seq++}.md`);
}

beforeAll(async () => {
  await fs.mkdir(PROJECT, { recursive: true });
  await fs.mkdir(join(PROJECT, 'sub'), { recursive: true });
  ({ executeFileWriteProposal } = await import('../../electron/main/proposals/executeFileWriteProposal'));
  ({ addProject } = await import('../../electron/main/projects/store'));
  CR = await import('../../electron/main/fs/conflictRegistry');
  await addProject(PROJECT);
});
afterAll(async () => {
  await CR.__flushPersistForTest(); // 等冲突登记的异步落盘清空，否则会在 rm 后重建目录致 ENOTEMPTY
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

function proposal(over: Partial<FileWriteProposal> & Pick<FileWriteProposal, 'path' | 'mode'>): FileWriteProposal {
  return {
    kind: 'file.write',
    status: 'pending',
    id: `p-${Math.random().toString(36).slice(2)}`,
    ownerId: 'owner-1',
    conversationId: 'conv-mvrn',
    title: 't',
    description: 'd',
    createdAt: 0,
    forceApproval: false,
    ...over,
  };
}

describe('S32·G49 manage_files move/rename 执行器', () => {
  it('rename：改名成功、旧路径消失、新路径出现', async () => {
    const p = fresh('a');
    await fs.writeFile(p, 'hi');
    await executeFileWriteProposal(proposal({ path: p, mode: 'rename', newName: 'renamed.md' }));
    expect(existsSync(p)).toBe(false);
    expect(existsSync(join(PROJECT, 'renamed.md'))).toBe(true);
  });

  it('move：移进子目录成功', async () => {
    const p = fresh('b');
    await fs.writeFile(p, 'hi');
    await executeFileWriteProposal(proposal({ path: p, mode: 'move', destDir: join(PROJECT, 'sub') }));
    expect(existsSync(p)).toBe(false);
    expect(existsSync(join(PROJECT, 'sub', p.split('/').pop()!))).toBe(true);
  });

  it('rename 撞名：拒绝、源不动', async () => {
    const p = fresh('c');
    await fs.writeFile(p, 'hi');
    await fs.writeFile(join(PROJECT, 'taken.md'), 'other');
    await expect(
      executeFileWriteProposal(proposal({ path: p, mode: 'rename', newName: 'taken.md' })),
    ).rejects.toThrow();
    expect(existsSync(p)).toBe(true); // 撞名绝不覆盖，源不动
  });

  it('项目外文件：拒绝（仅支持项目内）', async () => {
    const outside = join(ORU_DIR, 'loose.md');
    await fs.writeFile(outside, 'hi');
    await expect(
      executeFileWriteProposal(proposal({ path: outside, mode: 'rename', newName: 'x.md' })),
    ).rejects.toThrow();
  });

  it('move 目标目录不存在：优雅拒绝、源不动（不抛裸 ENOENT，review C-1 回归）', async () => {
    const p = fresh('d');
    await fs.writeFile(p, 'hi');
    await expect(
      executeFileWriteProposal(proposal({ path: p, mode: 'move', destDir: join(PROJECT, 'nope') })),
    ).rejects.toThrow(/不是已存在的目录|not an existing directory/);
    expect(existsSync(p)).toBe(true);
  });

  it('冲突卡开着时 move/rename 不被 defer——它们不动内容段（review 回归）', async () => {
    const p = fresh('e');
    await fs.writeFile(p, 'hi');
    CR.markConflictOpen(p); // 该文件正开着内容冲突卡
    // rename 不涉冲突段，应照常执行（不抛「已挂起」）
    await executeFileWriteProposal(proposal({ path: p, mode: 'rename', newName: 'renamed-e.md' }));
    expect(existsSync(join(PROJECT, 'renamed-e.md'))).toBe(true);
    CR.clearConflict(p);
  });
});
