/**
 * 结构粗筛单测（recall PRD §5.3 第三档 / §5.4，gate 在数据后）
 *
 * 候选简介块小到一次喂得下小模型时不粗筛（候选 = 全部 active）；多到超预算才按**硬维度**砍。
 * 本期实现「近期」这一维（briefs 已按 updated 倒序，取预算内最近的几条）；不按话题、不预建聚类。
 * 项目维度优先作为 gate-on-data 的进一步细化（默认不建，对齐「贵的默认不建」）。
 */
import { describe, expect, it } from 'vitest';
import type { EpisodeBrief } from '../../electron/main/memory/recall/briefs';
import {
  filterBriefsByProject,
  prefilterBriefsByBudget,
} from '../../electron/main/memory/recall/prefilter';
import { projectIdOfCompressed } from '../../electron/main/memory/compressedPath';

function brief(id: string, len: number, projectId?: string): EpisodeBrief {
  return { id, line: id + ':' + 'x'.repeat(len), title: id, projectId };
}

describe('prefilterBriefsByBudget', () => {
  it('总量在预算内 → 原样返回（不粗筛）', () => {
    const briefs = [brief('a', 10), brief('b', 10)];
    expect(prefilterBriefsByBudget(briefs, 1000)).toEqual(briefs);
  });

  it('超预算 → 只留最近的几条（briefs 已按 updated 倒序，取前缀）', () => {
    const briefs = [brief('recent1', 40), brief('recent2', 40), brief('old1', 40), brief('old2', 40)];
    const kept = prefilterBriefsByBudget(briefs, 100);
    // 100 预算 ≈ 容 2 条（每条 line ≈ 47 字符）；保留靠前（最近）的
    expect(kept.length).toBeLessThan(4);
    expect(kept[0].id).toBe('recent1');
    expect(kept.map((b) => b.id)).not.toContain('old2');
  });

  it('至少保留 1 条（即便单条就超预算）', () => {
    const kept = prefilterBriefsByBudget([brief('huge', 9999)], 10);
    expect(kept.length).toBe(1);
  });

  it('空 → 空', () => {
    expect(prefilterBriefsByBudget([], 100)).toEqual([]);
  });
});

describe('projectIdOfCompressed（G20 归属派生）', () => {
  it("agent 域（首段 'twin'）→ undefined（全局，不带项目标注）", () => {
    expect(projectIdOfCompressed('twin/2026-05-10-foo')).toBeUndefined();
  });
  it('项目域（首段=projectId）→ 返回该 projectId', () => {
    expect(projectIdOfCompressed('oru/2026-05-10-bar')).toBe('oru');
  });
  it('形态非法 → undefined（按全局降级，粗筛只多带不错排）', () => {
    expect(projectIdOfCompressed('')).toBeUndefined();
  });
});

describe('filterBriefsByProject（G20 · 按归属圈定候选）', () => {
  const global1 = brief('twin/a', 10); // 无项目标注（全局）
  const projA = brief('projA/x', 10, 'projA');
  const projB = brief('projB/y', 10, 'projB');

  it('当前项目 A：留全局 + A，排除其他项目 B', () => {
    const kept = filterBriefsByProject([global1, projA, projB], 'projA');
    expect(kept.map((b) => b.id)).toEqual(['twin/a', 'projA/x']);
  });

  it('无当前项目（自由聊天 / 渠道回合）：只留全局，排除所有项目条目', () => {
    for (const cur of [null, undefined] as const) {
      const kept = filterBriefsByProject([global1, projA, projB], cur);
      expect(kept.map((b) => b.id)).toEqual(['twin/a']);
    }
  });

  it('全是全局条目 → 原样保留（多数记忆不分项目）', () => {
    const all = [brief('twin/a', 5), brief('twin/b', 5)];
    expect(filterBriefsByProject(all, 'projA')).toEqual(all);
  });
});
