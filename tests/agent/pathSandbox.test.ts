/**
 * isWithin —— 路径包含校验（deck 找回 §3.2 的 artifact.adopt 路径逃逸守卫复用它，
 * 与 agent 写盘同一把尺）。这里固定它对收编场景的承重判定。
 */
import { describe, expect, it } from 'vitest';
import { isWithin } from '../../electron/main/agent/agentTools/pathSandbox';

describe('isWithin — 项目内/逃逸判定', () => {
  const root = '/Users/x/proj';

  it('项目内的子目录 → true', () => {
    expect(isWithin('/Users/x/proj/冒险岛回忆杀', root)).toBe(true);
    expect(isWithin('/Users/x/proj/a/b/c', root)).toBe(true);
  });

  it('项目根自身 → true', () => {
    expect(isWithin('/Users/x/proj', root)).toBe(true);
  });

  it('../sibling 逃逸 → false', () => {
    expect(isWithin('/Users/x/proj/../other', root)).toBe(false);
    expect(isWithin('/Users/x/other', root)).toBe(false);
  });

  it('前缀相同但非子目录（proj-evil）→ false', () => {
    expect(isWithin('/Users/x/proj-evil/deck', root)).toBe(false);
  });
});
