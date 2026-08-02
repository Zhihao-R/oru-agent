/**
 * deckNarrativePath 路径计算单测
 */
import { describe, expect, it } from 'vitest';
import { deckNarrativePath } from '../../electron/main/deck/pathResolver';

describe('deckNarrativePath', () => {
  it('返回 <deckPath>/.narrative.md', () => {
    expect(deckNarrativePath('/p/deck')).toBe('/p/deck/.narrative.md');
  });
});
