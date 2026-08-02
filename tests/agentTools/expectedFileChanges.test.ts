/**
 * bash 预期文件申报的核验内核（PRD 第 7 项三层方案·执行命令层）。
 *
 * 承重判定：op 由前后状态推导、不由模型自报——前无后有 = create、前有且 mtime/size 变 = modify、
 * 前有后无 = delete、无变化 = 丢弃（未通过核验，说错的/编的不进「本轮文件变更」条）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveExpectedFiles,
  snapshotExpectedFiles,
  verifyExpectedChanges,
} from '../../electron/main/agent/agentTools/expectedFileChanges';

const DIR = join(tmpdir(), `oru-test-expfiles-${Date.now()}`);

beforeAll(async () => {
  await fs.mkdir(DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

describe('resolveExpectedFiles（入参校验 + 相对路径解析 + 去重）', () => {
  it('相对路径按 cwd 解析，绝对路径原样保留，重复路径去重', () => {
    expect(resolveExpectedFiles(['a.txt', '/abs/b.txt', 'a.txt'], '/work')).toEqual([
      '/work/a.txt',
      '/abs/b.txt',
    ]);
  });

  it('非数组 / 混入非字符串 → 空数组（申报格式坏了不拦命令，只是没有记录）', () => {
    expect(resolveExpectedFiles('a.txt', '/work')).toEqual([]);
    expect(resolveExpectedFiles(['a.txt', 42], '/work')).toEqual(['/work/a.txt']);
    expect(resolveExpectedFiles(undefined, '/work')).toEqual([]);
  });
});

describe('verifyExpectedChanges（前后状态比对推导 op）', () => {
  it('前无后有 → create', async () => {
    const p = join(DIR, 'created.txt');
    const snap = snapshotExpectedFiles([p]);
    await fs.writeFile(p, 'hi');
    expect(verifyExpectedChanges(snap)).toEqual([{ path: p, op: 'create' }]);
  });

  it('前有、内容变（mtime/size 变）→ modify', async () => {
    const p = join(DIR, 'modified.txt');
    await fs.writeFile(p, 'v1');
    utimesSync(p, new Date(Date.now() - 5000), new Date(Date.now() - 5000)); // 拉开 mtime，防同毫秒误判
    const snap = snapshotExpectedFiles([p]);
    await fs.writeFile(p, 'v2-longer');
    expect(verifyExpectedChanges(snap)).toEqual([{ path: p, op: 'modify' }]);
  });

  it('前有后无 → delete', async () => {
    const p = join(DIR, 'deleted.txt');
    await fs.writeFile(p, 'bye');
    const snap = snapshotExpectedFiles([p]);
    await fs.rm(p);
    expect(verifyExpectedChanges(snap)).toEqual([{ path: p, op: 'delete' }]);
  });

  it('申报了但没动 → 丢弃；始终不存在 → 丢弃', async () => {
    const untouched = join(DIR, 'untouched.txt');
    await fs.writeFile(untouched, 'same');
    utimesSync(untouched, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    const never = join(DIR, 'never.txt');
    const snap = snapshotExpectedFiles([untouched, never]);
    expect(verifyExpectedChanges(snap)).toEqual([]);
  });
});
