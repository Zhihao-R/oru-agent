/**
 * groupByCategory 单测
 *
 * 验证 Prompt 工作台左栏分组：
 * - 分组顺序跟随 CATEGORY_LABELS 键序（不按输入顺序、不字母序）
 * - 空 category 省略
 * - 组内保持输入相对顺序
 */
import { describe, expect, it } from 'vitest';
import type { PromptMeta } from '@shared/types';
import { groupByCategory } from '../../src/components/promptBench/PromptList';

const p = (id: string, category: PromptMeta['category']): PromptMeta => ({
  id,
  title: id,
  category,
});

describe('groupByCategory', () => {
  it('按 CATEGORY_LABELS 键序分组，省略空类', () => {
    const groups = groupByCategory([
      p('t1', 'tasks'),
      p('per1', 'persona'),
      p('m1', 'memory'),
    ]);
    // 键序 persona → memory → agent → tasks → taskboard；agent/taskboard 无项省略
    expect(groups.map((g) => g.category)).toEqual(['persona', 'memory', 'tasks']);
  });

  it('组内保持输入相对顺序', () => {
    const groups = groupByCategory([p('a', 'agent'), p('b', 'agent')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('空输入得空数组', () => {
    expect(groupByCategory([])).toEqual([]);
  });
});
