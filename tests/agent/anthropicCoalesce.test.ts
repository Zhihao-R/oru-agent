/**
 * Anthropic 相邻同角色合并 —— steering 把「将生效」落盘为独立 user 消息后，
 * 回放历史时与起回合 user 相邻，不合并会被 Anthropic 拒（400）。
 */
import { describe, expect, it } from 'vitest';
import { coalesceAdjacentSameRole } from '../../electron/main/agent/backends/anthropic';

describe('coalesceAdjacentSameRole', () => {
  it('相邻两条 user（起回合 + steering）合并成一条，content 拼成 block 数组', () => {
    const out = coalesceAdjacentSameRole([
      { role: 'user', content: '起回合' },
      { role: 'user', content: '【用户中途补充】顺便配色也调一下' },
      { role: 'assistant', content: '好的' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toEqual([
      { type: 'text', text: '起回合' },
      { type: 'text', text: '【用户中途补充】顺便配色也调一下' },
    ]);
    expect(out[1]).toEqual({ role: 'assistant', content: '好的' });
  });

  it('三条 user 连发也合并成一条', () => {
    const out = coalesceAdjacentSameRole([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'text', text: 'c' },
    ]);
  });

  it('正常交替不受影响（无相邻同角色时原样）', () => {
    const input = [
      { role: 'user' as const, content: 'u1' },
      { role: 'assistant' as const, content: 'a1' },
      { role: 'user' as const, content: 'u2' },
    ];
    const out = coalesceAdjacentSameRole(input);
    expect(out).toEqual(input);
  });

  it('tool_result（user 角色 block 数组）与后续 steering user 文本合并，混排 content', () => {
    const out = coalesceAdjacentSameRole([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'edit', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
      { role: 'user', content: '【用户中途补充】停一下' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].role).toBe('user');
    expect(out[1].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'done' },
      { type: 'text', text: '【用户中途补充】停一下' },
    ]);
  });

  it('不 mutate 入参原 content', () => {
    const first = { role: 'user' as const, content: '起回合' };
    coalesceAdjacentSameRole([first, { role: 'user', content: 'b' }]);
    expect(first.content).toBe('起回合'); // 原对象未被改写
  });
});
