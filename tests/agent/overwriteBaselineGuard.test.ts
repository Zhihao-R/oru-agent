/**
 * S02 · G88：守卫三整体覆盖的基线判定（锁外早失败层）。
 *
 * 理想页 G3 口径：整体覆盖落笔前核对「全文仍是读到的那一版」，不满足按「目标已移动」退回。
 * 本组测锁外 checkGuard 的 'baseline-moved'（工具 emit / 执行器复检共用）；
 * 锁内的最终判定在 commitWorkfileWrite（tests/fs/workfileWrite.test.ts 的 G88 组）。
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import {
  checkGuard,
  clearConvFileState,
  guardErrorText,
  recordRead,
} from '../../electron/main/agent/conversationFileState';

const tmp = mkdtempSync(join(tmpdir(), 'g88-guard-'));
const CONV = 'conv-g88';

function readAndRecord(path: string, content: string): void {
  writeFileSync(path, content);
  recordRead(CONV, path, {
    mtime: Math.floor(statSync(path).mtimeMs),
    content,
    isPartialView: false,
  });
}

afterEach(() => clearConvFileState(CONV));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('checkGuard overwrite 基线判定（G88）', () => {
  it('磁盘仍是读到的那一版 → ok', () => {
    const p = join(tmp, 'same.md');
    readAndRecord(p, '内容 A');
    expect(checkGuard(CONV, p, 'overwrite')).toBe('ok');
  });

  it('读后被外部改动 → baseline-moved（不再静默放行 last-writer-wins）', () => {
    const p = join(tmp, 'moved.md');
    readAndRecord(p, '内容 A');
    writeFileSync(p, '用户改过的内容');
    expect(checkGuard(CONV, p, 'overwrite')).toBe('baseline-moved');
  });

  it('baseline-moved 的指引文案：指向重新 read_file', () => {
    expect(guardErrorText('baseline-moved', '/x/y.md')).toContain('read_file');
  });

  it('部分读仍先报 partial-only（整读要求优先于基线比对）', () => {
    const p = join(tmp, 'partial.md');
    writeFileSync(p, 'l1\nl2\nl3');
    recordRead(CONV, p, {
      mtime: Math.floor(statSync(p).mtimeMs),
      content: 'l1',
      offset: 1,
      limit: 1,
      isPartialView: true,
    });
    expect(checkGuard(CONV, p, 'overwrite')).toBe('partial-only');
  });
});
