import { describe, it, expect } from 'vitest';
import { deckTabChrome } from '@/lib/deckTabChrome';

describe('deckTabChrome — 标签栏主按钮动作（按有无真 slides 派生）', () => {
  it('无幻灯片（slideCount=0）：主按钮动作 = generate（首次生成）', () => {
    expect(deckTabChrome({ slideCount: 0 }).primaryAction).toBe('generate');
  });

  it('有幻灯片（slideCount>0）：主按钮动作 = update', () => {
    expect(deckTabChrome({ slideCount: 9 }).primaryAction).toBe('update');
  });

  it('边界 slideCount=1：已有 slides → update', () => {
    expect(deckTabChrome({ slideCount: 1 }).primaryAction).toBe('update');
  });
});
