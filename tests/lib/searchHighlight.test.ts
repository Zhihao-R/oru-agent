import { describe, expect, it } from 'vitest';
import { snippet, splitHighlight } from '@/lib/searchHighlight';

describe('splitHighlight', () => {
  it('命中词切成中段 hit、前后非 hit', () => {
    expect(splitHighlight('Q2 增长复盘', '增长')).toEqual([
      { text: 'Q2 ', hit: false },
      { text: '增长', hit: true },
      { text: '复盘', hit: false },
    ]);
  });

  it('大小写不敏感，保留原文大小写', () => {
    expect(splitHighlight('React Hooks', 'react')).toEqual([
      { text: 'React', hit: true },
      { text: ' Hooks', hit: false },
    ]);
  });

  it('无命中 / 空查询 → 整段非 hit', () => {
    expect(splitHighlight('hello', 'zzz')).toEqual([{ text: 'hello', hit: false }]);
    expect(splitHighlight('hello', '  ')).toEqual([{ text: 'hello', hit: false }]);
  });
});

describe('snippet', () => {
  it('长消息两头按需省略，只给关键词前 8 / 后 22', () => {
    const s = snippet('0123456789KEY' + 'x'.repeat(30), 'KEY');
    expect(s.hit).toBe('KEY');
    expect(s.pre).toBe('23456789'); // KEY 前 8 字
    expect(s.post).toBe('x'.repeat(22)); // KEY 后 22 字
    expect(s.ellipsisStart).toBe(true);
    expect(s.ellipsisEnd).toBe(true);
  });

  it('命中靠头 / 文本短 → 不省略', () => {
    const s = snippet('KEYabc', 'KEY');
    expect(s).toEqual({ pre: '', hit: 'KEY', post: 'abc', ellipsisStart: false, ellipsisEnd: false });
  });

  it('无命中 → 截首段、hit 为空', () => {
    expect(snippet('hello', 'zzz')).toEqual({
      pre: 'hello',
      hit: '',
      post: '',
      ellipsisStart: false,
      ellipsisEnd: false,
    });
  });
});
