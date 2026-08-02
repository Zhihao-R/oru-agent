import { describe, it, expect } from 'vitest';
import {
  periodOf,
  nextGreeting,
  GREETING_REFRESH_MS,
  type Greeting,
  type GreetingMemo,
} from '@/components/home/homeGreeting';

describe('periodOf', () => {
  it('八个时段左闭右开、无缝覆盖 0–23', () => {
    const expected: Record<number, string> = {};
    for (let h = 0; h < 5; h++) expected[h] = 'lateNight';
    for (let h = 5; h < 8; h++) expected[h] = 'earlyMorning';
    for (let h = 8; h < 11; h++) expected[h] = 'morning';
    for (let h = 11; h < 13; h++) expected[h] = 'noon';
    for (let h = 13; h < 15; h++) expected[h] = 'afternoon';
    for (let h = 15; h < 17; h++) expected[h] = 'lateAfternoon';
    for (let h = 17; h < 19; h++) expected[h] = 'evening';
    for (let h = 19; h < 23; h++) expected[h] = 'night';
    for (let h = 23; h < 24; h++) expected[h] = 'lateNight';
    for (let h = 0; h < 24; h++) expect(periodOf(h)).toBe(expected[h]);
  });
});

describe('nextGreeting', () => {
  const list: Greeting[] = [{ heading: 'A' }, { heading: 'B', sub: 'b' }, { heading: 'C' }];
  const memo = (over: Partial<GreetingMemo> = {}): GreetingMemo => ({
    greeting: { heading: 'A' },
    period: 'morning',
    lang: 'zh',
    shownAt: 0,
    ...over,
  });

  it('无记忆时按 rand 首取', () => {
    expect(nextGreeting(null, list, 'morning', 'zh', 1000, 0.5)).toEqual({
      greeting: { heading: 'B', sub: 'b' },
      period: 'morning',
      lang: 'zh',
      shownAt: 1000,
    });
  });

  it('同时段、同语言、未过 20 分钟 → 原样沿用（跨页不跳，且引用不变）', () => {
    const prev = memo({ shownAt: 1000 });
    const out = nextGreeting(prev, list, 'morning', 'zh', 1000 + GREETING_REFRESH_MS - 1, 0.99);
    expect(out).toBe(prev); // 同一引用 → React 不会重渲染
  });

  it('时段变化 → 重掷并刷新 shownAt', () => {
    const prev = memo({ period: 'morning', shownAt: 1000 });
    const out = nextGreeting(prev, list, 'noon', 'zh', 2000, 0);
    expect(out.period).toBe('noon');
    expect(out.shownAt).toBe(2000);
    expect(out.greeting).toEqual({ heading: 'A' });
  });

  it('语言切换 → 重掷（即使同时段、未过 20 分钟）', () => {
    const prev = memo({ lang: 'zh', shownAt: 1000 });
    const out = nextGreeting(prev, list, 'morning', 'en', 1500, 0);
    expect(out.lang).toBe('en');
    expect(out.shownAt).toBe(1500);
  });

  it('满 20 分钟 → 重掷，且排除刚显示的那句', () => {
    const prev = memo({ greeting: { heading: 'A' }, shownAt: 1000 });
    // 过 20 分钟后重掷：候选被过滤成 [B, C]，rand=0 取到 B（绝不会再是 A）
    const out = nextGreeting(prev, list, 'morning', 'zh', 1000 + GREETING_REFRESH_MS, 0);
    expect(out.greeting).toEqual({ heading: 'B', sub: 'b' });
    expect(out.shownAt).toBe(1000 + GREETING_REFRESH_MS);
  });

  it('组内仅一句时排除后回退到原组，不会取空', () => {
    const solo: Greeting[] = [{ heading: 'only' }];
    const prev = memo({ greeting: { heading: 'only' }, shownAt: 0 });
    const out = nextGreeting(prev, solo, 'morning', 'zh', GREETING_REFRESH_MS, 0.9);
    expect(out.greeting).toEqual({ heading: 'only' });
  });
});
