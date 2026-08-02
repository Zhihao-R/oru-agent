/**
 * dream 夜记时间锚点：buildDreamPrompt 顶部注入「距上次整理」跨度，供夜记守则说准跨度
 * （别把跨了几天的 episode 一律说成"今天"）。describeSinceLastReview 是其纯函数内核。
 */
import { describe, expect, it } from 'vitest';
import { describeSinceLastReview, buildDreamPrompt } from '../../electron/main/memory/dreamPrompt';

const DAY = 24 * 3600_000;
const NOW = 1_700_000_000_000;

describe('describeSinceLastReview', () => {
  it('从没跑过（lastDreamAt=0）→ 说明是第一次整理，不报天数', () => {
    const s = describeSinceLastReview(0, NOW);
    expect(s).toContain('第一次整理');
    expect(s).not.toMatch(/\d+ 天/);
  });

  it('跨 3 天 → 约 3 天', () => {
    expect(describeSinceLastReview(NOW - 3 * DAY, NOW)).toContain('约 3 天');
  });

  it('不足 1 天也至少说 1 天（不出现"约 0 天"）', () => {
    const s = describeSinceLastReview(NOW - 1000, NOW);
    expect(s).toContain('约 1 天');
    expect(s).not.toContain('约 0 天');
  });

  it('四舍五入到天：50 小时 → 约 2 天', () => {
    expect(describeSinceLastReview(NOW - 50 * 3600_000, NOW)).toContain('约 2 天');
  });
});

describe('buildDreamPrompt', () => {
  it('顶部注入「距上次整理」跨度段', () => {
    const prompt = buildDreamPrompt({
      lastDreamAt: NOW - 5 * DAY,
      now: NOW,
      episodeIndex: '- x/y: 标题 - 描述',
      userProfileText: '_(空)_',
      projectProfileText: '_(无当前项目)_',
      selfText: '人设',
      currentProjectId: null,
    });
    expect(prompt).toContain('## 距上次整理');
    expect(prompt).toContain('约 5 天');
    // 跨度段在 episode 索引之前——模型先知跨度再看料
    expect(prompt.indexOf('## 距上次整理')).toBeLessThan(prompt.indexOf('## 近期 active episode 索引'));
  });
});
