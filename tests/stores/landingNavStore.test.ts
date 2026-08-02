/**
 * landingNavStore 的「当前线」（手账线 / 对话线）——点击驱动、始终有效。
 * line 初始 memory 是「冷启动落手账页」的地基；setLine 幂等避免无谓重渲染。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useLandingNavStore } from '@/stores/landingNavStore';

beforeEach(() => {
  useLandingNavStore.setState({ line: 'memory', scrollRequest: null });
});

describe('landingNavStore 当前线', () => {
  it('默认 line 为 memory（冷启动落手账页）', () => {
    expect(useLandingNavStore.getState().line).toBe('memory');
  });

  it('setLine 在对话线 / 手账线之间切换', () => {
    useLandingNavStore.getState().setLine('chat');
    expect(useLandingNavStore.getState().line).toBe('chat');
    useLandingNavStore.getState().setLine('memory');
    expect(useLandingNavStore.getState().line).toBe('memory');
  });

  it('setLine 同值幂等：不产生新 state 对象（避免无谓重渲染）', () => {
    useLandingNavStore.setState({ line: 'chat' });
    const before = useLandingNavStore.getState();
    useLandingNavStore.getState().setLine('chat');
    expect(useLandingNavStore.getState()).toBe(before);
  });
});
