/**
 * git/rollback 子系统的纯逻辑层单测——把"喂 git 输出字符串 → 断言解析/判定"从 smoke
 * （需真仓库 + electron 运行时）下沉到 vitest。承重点是 classifyOnePath：误判会让用户活编辑
 * 被 rollback 静默丢失，故穷举全部分支。
 */
import { describe, it, expect } from 'vitest';
import { isProtectedBranch, mapShortStatus } from '../../electron/main/git/workflow';
import { parseGitDiffOutput, extractRedoTag } from '../../electron/main/git/rollback';
import { classifyOnePath } from '../../electron/main/tasks/git';

describe('isProtectedBranch', () => {
  it('保护主干、放行特性分支', () => {
    expect(isProtectedBranch('main')).toBe(true);
    expect(isProtectedBranch('dev/qa02')).toBe(false);
    expect(isProtectedBranch('oru/feat-x')).toBe(false);
  });
});

describe('mapShortStatus', () => {
  it.each([
    ['?', 'untracked'],
    ['M', 'modified'],
    ['A', 'added'],
    ['D', 'deleted'],
    ['R', 'renamed'],
    ['U', 'conflicted'],
    ['X', 'modified'], // 未知码回落 modified
  ])('%s → %s', (code, expected) => {
    expect(mapShortStatus(code)).toBe(expected);
  });
});

describe('parseGitDiffOutput', () => {
  it('空 → []；去空白去空行', () => {
    expect(parseGitDiffOutput('')).toEqual([]);
    expect(parseGitDiffOutput('\n  \n')).toEqual([]);
    expect(parseGitDiffOutput('a.ts\n  b/c.ts \n\nd.ts\n')).toEqual(['a.ts', 'b/c.ts', 'd.ts']);
  });
});

describe('extractRedoTag', () => {
  it('null/无 tag → null；命中 → 取 tag', () => {
    expect(extractRedoTag(null)).toBeNull();
    expect(extractRedoTag(undefined)).toBeNull();
    expect(extractRedoTag('普通 summary')).toBeNull();
    expect(
      extractRedoTag('已完成\n[已撤回 @ 2026-07-23T00:00:00Z, redo tag: oru/pre-rollback-abc-123]'),
    ).toBe('oru/pre-rollback-abc-123');
  });
  it('只认 oru/pre-rollback- 前缀（防误取别的 tag 名）', () => {
    expect(extractRedoTag('redo tag: some/other-tag')).toBeNull();
  });
});

describe('classifyOnePath（承重：误判丢用户改动）', () => {
  it('task 启动前不在 dirty 列表（preSha=undefined）→ affected', () => {
    expect(classifyOnePath({ preSha: undefined, currentSha: 'x', fileExists: true })).toBe('affected');
  });

  it('用户预改过、task 也改了（sha 不同、文件在）→ mixed（保护用户活编辑）', () => {
    expect(classifyOnePath({ preSha: 'user', currentSha: 'task', fileExists: true })).toBe('mixed');
  });

  it('用户预改过、task 没动（sha 相同）→ excluded', () => {
    expect(classifyOnePath({ preSha: 'same', currentSha: 'same', fileExists: true })).toBe('excluded');
  });

  it('文件被 task 删除、用户预改非空 → affected（可安全回滚）', () => {
    expect(classifyOnePath({ preSha: 'had-content', currentSha: '', fileExists: false })).toBe('affected');
  });

  it('文件被删、用户预改本身即删（preSha 空串）→ excluded（task 没实质改动）', () => {
    expect(classifyOnePath({ preSha: '', currentSha: '', fileExists: false })).toBe('excluded');
  });

  it('hash 失败但文件仍在（currentSha 空、fileExists）→ mixed（不误当删除）', () => {
    expect(classifyOnePath({ preSha: 'user', currentSha: '', fileExists: true })).toBe('mixed');
  });
});
