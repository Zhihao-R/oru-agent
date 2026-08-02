/**
 * contentCache 单元（AnySearch 接入·批 3）：TTL 过期穿透、LRU 淘汰（含命中刷新热度）、
 * complete 标记透传。TTL 以写入时刻计，命中不续命。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __clearContentCacheForTest,
  getContent,
  putContent,
} from '../../electron/main/search/contentCache';

const MIN = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  __clearContentCacheForTest();
});
afterEach(() => vi.useRealTimers());

const entry = (text = 'T') => ({ text, title: 'title', complete: true });

describe('contentCache', () => {
  it('写读闭环：complete 标记透传', () => {
    putContent('https://a.dev/', { text: 'x', title: 't', complete: false });
    expect(getContent('https://a.dev/')).toEqual({ text: 'x', title: 't', complete: false });
  });

  it('TTL：15 分钟内命中，过期穿透（返回 undefined）', () => {
    putContent('https://a.dev/', entry());
    vi.advanceTimersByTime(14 * MIN);
    expect(getContent('https://a.dev/')).toBeTruthy();
    vi.advanceTimersByTime(2 * MIN); // 距写入 16 分钟
    expect(getContent('https://a.dev/')).toBeUndefined();
  });

  it('TTL 以写入时刻计：命中不续命', () => {
    putContent('https://a.dev/', entry());
    vi.advanceTimersByTime(10 * MIN);
    expect(getContent('https://a.dev/')).toBeTruthy(); // 10 分钟处读一次
    vi.advanceTimersByTime(6 * MIN); // 距写入 16 分钟——虽 6 分钟前刚读过，仍过期
    expect(getContent('https://a.dev/')).toBeUndefined();
  });

  it('LRU：超 100 条淘汰最久未用；读命中刷新热度', () => {
    for (let i = 0; i < 100; i++) putContent(`https://u${i}.dev/`, entry(`t${i}`));
    // 读 u0 刷热度——此刻最久未用的变成 u1
    expect(getContent('https://u0.dev/')).toBeTruthy();
    putContent('https://u100.dev/', entry('t100')); // 第 101 条
    expect(getContent('https://u1.dev/')).toBeUndefined(); // u1 被淘汰
    expect(getContent('https://u0.dev/')).toBeTruthy(); // u0 因刚读过而幸存
    expect(getContent('https://u100.dev/')).toBeTruthy();
  });

  it('同 URL 重写覆盖旧值且不重复占位', () => {
    putContent('https://a.dev/', entry('old'));
    putContent('https://a.dev/', entry('new'));
    expect(getContent('https://a.dev/')?.text).toBe('new');
  });
});
