/**
 * PT-007 回归：重命名输入框只预选基名、不含扩展名（防一打字连 .md 一起替换掉）。
 * baseNameEnd 给出选区终点——扩展名前最后一个点；无扩展名 / dotfile 全选。
 */
import { describe, it, expect } from 'vitest';
import { baseNameEnd } from '../../src/components/FileTree';

describe('baseNameEnd · 重命名预选基名', () => {
  it('普通文件：选到扩展名前', () => {
    expect(baseNameEnd('readme.md')).toBe('readme'.length);
    expect(baseNameEnd('季度复盘.md')).toBe('季度复盘'.length);
  });

  it('多点名：选到最后一个点前', () => {
    expect(baseNameEnd('a.test.md')).toBe('a.test'.length);
  });

  it('无扩展名（文件夹 / README）：全选', () => {
    expect(baseNameEnd('README')).toBe('README'.length);
    expect(baseNameEnd('归档')).toBe('归档'.length);
  });

  it('dotfile（点在最前，dot===0）：全选、不当扩展名', () => {
    expect(baseNameEnd('.gitignore')).toBe('.gitignore'.length);
  });
});
