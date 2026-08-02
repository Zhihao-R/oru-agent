import { beforeEach, describe, expect, it } from 'vitest';
import {
  definePrompt,
  getPrompt,
  listPrompts,
  __resetForTest,
} from '../../electron/main/prompts/registry';

describe('prompts/registry', () => {
  beforeEach(() => __resetForTest());

  it('definePrompt 返回 body 原文，且登记进清单', () => {
    const body = definePrompt(
      { id: 'demo', title: '示例', category: 'agent' },
      '正文内容',
    );
    expect(body).toBe('正文内容');
    expect(getPrompt('demo')).toEqual({
      id: 'demo',
      title: '示例',
      category: 'agent',
      body: '正文内容',
    });
  });

  it('listPrompts 按 category 再 id 稳定排序', () => {
    definePrompt({ id: 'b', title: 'B', category: 'tasks' }, 'x');
    definePrompt({ id: 'a', title: 'A', category: 'agent' }, 'y');
    expect(listPrompts().map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('id 重复直接抛错', () => {
    definePrompt({ id: 'dup', title: '一', category: 'agent' }, 'x');
    expect(() =>
      definePrompt({ id: 'dup', title: '二', category: 'agent' }, 'y'),
    ).toThrow(/dup/);
  });
});
