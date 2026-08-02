import { describe, expect, it } from 'vitest';
import type { FileNode } from '../../shared/types';
import { fileKind, getExtension } from '../../src/lib/fileKind';

/**
 * 文件树五类分类（文件树认类型 §2）——目录统一 'folder'（不自动辨别 deck），文件靠扩展名。
 */
function file(name: string): FileNode {
  return { name, path: name, isDirectory: false };
}
function dir(name: string): FileNode {
  return { name, path: name, isDirectory: true };
}

describe('fileKind — 文件按扩展名分类', () => {
  it('markdown：md / markdown / txt', () => {
    expect(fileKind(file('a.md'))).toBe('markdown');
    expect(fileKind(file('a.markdown'))).toBe('markdown');
    expect(fileKind(file('readme.txt'))).toBe('markdown');
    expect(fileKind(file('A.MD'))).toBe('markdown'); // 大小写不敏感
  });

  it('html：html / htm', () => {
    expect(fileKind(file('index.html'))).toBe('html');
    expect(fileKind(file('page.htm'))).toBe('html');
  });

  it('image：png/jpg/jpeg/gif/webp/svg', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
      expect(fileKind(file(`henesys.${ext}`))).toBe('image');
    }
  });

  it('other：未识别扩展名 / 无扩展名', () => {
    expect(fileKind(file('data.json'))).toBe('other');
    expect(fileKind(file('main.ts'))).toBe('other');
    expect(fileKind(file('LICENSE'))).toBe('other');
    expect(fileKind(file('.gitignore'))).toBe('other'); // 前导点不算扩展名分隔
  });
});

describe('fileKind — 目录统一 folder', () => {
  it('任何目录 → folder（不自动辨别 deck）', () => {
    expect(fileKind(dir('冒险岛回忆杀'))).toBe('folder');
    expect(fileKind(dir('dist'))).toBe('folder');
    expect(fileKind(dir('src'))).toBe('folder');
  });
});

describe('getExtension', () => {
  it('取末段小写；无扩展名 / 隐藏文件 → 空', () => {
    expect(getExtension('a.PNG')).toBe('png');
    expect(getExtension('archive.tar.gz')).toBe('gz');
    expect(getExtension('Makefile')).toBe('');
    expect(getExtension('.env')).toBe('');
  });
});
