/**
 * S29·G90③④ 未决冲突登记表：开卡登记、AI 写入挂起记账、裁决撤登记取回对话、崩溃重启扫描。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-conflictreg-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

let CR!: typeof import('../../electron/main/fs/conflictRegistry');

let seq = 0;
function freshKey(): string {
  return resolve(join(ORU_DIR, `f-${seq++}.md`));
}

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  CR = await import('../../electron/main/fs/conflictRegistry');
});
beforeEach(() => CR.__resetConflictRegistryForTest());
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('冲突登记表 · 开卡/挂起/裁决', () => {
  it('开卡后 isConflictOpen 为真，裁决后为假', () => {
    const k = freshKey();
    expect(CR.isConflictOpen(k)).toBe(false);
    CR.markConflictOpen(k);
    expect(CR.isConflictOpen(k)).toBe(true);
    CR.clearConflict(k);
    expect(CR.isConflictOpen(k)).toBe(false);
  });

  it('路径归一：不同字面同一文件拿到同一条登记', () => {
    const k = freshKey();
    CR.markConflictOpen(k);
    expect(CR.isConflictOpen(`${k}`)).toBe(true);
    expect(CR.isConflictOpen(join(k, '..', k.split('/').pop()!))).toBe(true);
  });

  it('裁决取回被挂起的对话（去重），未挂起则空', () => {
    const k = freshKey();
    CR.markConflictOpen(k);
    CR.recordDeferredWrite(k, 'conv-A');
    CR.recordDeferredWrite(k, 'conv-A'); // 去重
    CR.recordDeferredWrite(k, 'conv-B');
    const convs = CR.clearConflict(k).sort();
    expect(convs).toEqual(['conv-A', 'conv-B']);
    // 二次裁决无残留
    expect(CR.clearConflict(k)).toEqual([]);
  });

  it('只在真开着卡时才记挂起（避免脏账）', () => {
    const k = freshKey();
    CR.recordDeferredWrite(k, 'conv-X'); // 未开卡 → 不记
    CR.markConflictOpen(k);
    expect(CR.clearConflict(k)).toEqual([]);
  });
});

describe('冲突登记表 · 崩溃重启扫描', () => {
  it('残留的未决冲突被扫出并返回，扫后清空', async () => {
    const a = freshKey();
    const b = freshKey();
    CR.markConflictOpen(a);
    CR.markConflictOpen(b);
    await CR.__flushPersistForTest(); // 等落盘链清空
    // 模拟重启：清内存，从盘扫
    CR.__resetConflictRegistryForTest();
    const residual = (await CR.scanOpenConflictsOnBoot()).sort();
    expect(residual).toEqual([a, b].sort());
    // 扫后持久档已清：再扫为空
    expect(await CR.scanOpenConflictsOnBoot()).toEqual([]);
  });

  it('无残留档时扫描返回空、不抛', async () => {
    CR.__resetConflictRegistryForTest();
    await CR.scanOpenConflictsOnBoot(); // 清掉可能的残留
    expect(await CR.scanOpenConflictsOnBoot()).toEqual([]);
  });
});
