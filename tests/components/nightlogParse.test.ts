/**
 * 整理记录的 changelog 解析——夜记段落与明细行的切分、倒序展示
 */
import { describe, expect, it } from 'vitest';
import { parseChangelog } from '../../src/components/memory/changelogParse';

describe('parseChangelog', () => {
  it('按 ## 日期分夜：标题后段落是夜记、`- ` 行是明细；展示顺序最近在前', () => {
    const md = [
      '## 2026-06-11',
      '',
      '这几天你问锻炼、聊作息，并成了一条。',
      '',
      '- 合并 twin/a、twin/b → twin/c',
      '',
      '## 2026-06-12',
      '',
      '把理县徒步的几条笔记并成了一条。',
      '',
      '- 校对 twin/2026-06-10-foo：依据「这是我第二次徒步」（改前版本在回收站）',
      '- 收起 twin/2026-06-08-bar：对话内短期约定',
    ].join('\n');
    const nights = parseChangelog(md);
    expect(nights.map((n) => n.date)).toEqual(['2026-06-12', '2026-06-11']);
    expect(nights[0].note).toBe('把理县徒步的几条笔记并成了一条。');
    expect(nights[0].details).toHaveLength(2);
    expect(nights[0].details[0]).toContain('校对');
    expect(nights[1].details).toEqual(['合并 twin/a、twin/b → twin/c']);
  });

  it('只有明细没有夜记（老格式）→ note 为空串不报错；空文件 → 空数组', () => {
    const nights = parseChangelog('## 2026-06-10\n- 收起 twin/x：寒暄\n');
    expect(nights).toHaveLength(1);
    expect(nights[0].note).toBe('');
    expect(nights[0].details).toEqual(['收起 twin/x：寒暄']);
    expect(parseChangelog('')).toEqual([]);
  });

  it('夜记多段落合并为一段展示（明细行之外的非空行都算夜记）', () => {
    const nights = parseChangelog('## 2026-06-12\n\n第一段。\n第二段。\n\n- 明细一\n');
    expect(nights[0].note).toBe('第一段。 第二段。');
  });
});
