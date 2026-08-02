/**
 * Deck 回喊 / 标注文案单测：清单格式化（含 null 页 = deck 整体）/ 建议式 advise prompt 带 rawPlan +
 * 措辞约束 / 残留中性标注不臆断原因。
 */
import { describe, expect, it } from 'vitest';
import {
  formatErrorList,
  buildAdvisePrompt,
  buildRefeedText,
  residualNote,
} from '../../electron/main/deck/deckFixPrompts';
import type { DeckValidationError } from '../../electron/main/deck/validateDeck';

const ERRORS: DeckValidationError[] = [
  { page: 12, kind: 'overflow', message: '标题溢出页框' },
  { page: 7, kind: 'broken-image', message: 'images/hero.png 加载失败' },
  { page: 16, kind: 'blank', message: '整页空白' },
];

describe('formatErrorList', () => {
  it('按页号升序、带中文 kind 标签', () => {
    const out = formatErrorList(ERRORS);
    const lines = out.split('\n');
    expect(lines[0]).toContain('第 7 页');
    expect(lines[1]).toContain('第 12 页');
    expect(lines[2]).toContain('第 16 页');
    expect(out).toContain('【失效图】');
    expect(out).toContain('【内容溢出】');
    expect(out).toContain('【空白页】');
  });

  it('page=null 渲成"deck 整体"且排在最前', () => {
    const withStructural: DeckValidationError[] = [
      { page: 3, kind: 'overflow', message: '溢出' },
      { page: null, kind: 'structure', message: '未找到任何 slide' },
    ];
    const lines = formatErrorList(withStructural).split('\n');
    expect(lines[0]).toContain('deck 整体');
    expect(lines[0]).toContain('【结构契约】');
    expect(lines[0]).not.toContain('第 0 页'); // 不退化成魔法值页号
    expect(lines[1]).toContain('第 3 页');
  });

  it('不改动入参数组顺序（纯函数）', () => {
    const copy = [...ERRORS];
    formatErrorList(ERRORS);
    expect(ERRORS).toEqual(copy);
  });
});

describe('buildAdvisePrompt', () => {
  it('含项数、清单、原始 rawPlan、建议式措辞、"只处理列出的页"', () => {
    const out = buildAdvisePrompt(ERRORS, 'RAW_PLAN_MARKER 做一份 12 页 deck');
    expect(out).toContain('3 项');
    expect(out).toContain('第 7 页');
    expect(out).toContain('RAW_PLAN_MARKER'); // 透传原任务意图（空白页才补得对，也覆盖"用户意图"）
    expect(out).toContain('建议修');
    expect(out).toMatch(/不用改它|可保留|该保留/); // 建议式：可保留
    expect(out).toContain('收尾说明'); // 保留的要讲清
    expect(out).toMatch(/只处理|别重做整个 deck/);
  });

  it('不含硬卡措辞（必须修 / 必须清零）', () => {
    const out = buildAdvisePrompt(ERRORS, 'RAW');
    expect(out).not.toContain('必须修');
    expect(out).not.toContain('必须清零');
  });
});

describe('buildRefeedText', () => {
  it('含项数、清单、"修掉再收尾"与 acknowledge_residual 用法（不带 rawPlan）', () => {
    const out = buildRefeedText(ERRORS);
    expect(out).toContain('3 项');
    expect(out).toContain('第 7 页');
    expect(out).toContain('acknowledge_residual'); // 显式入参用法（决策 2）
    expect(out).toMatch(/再次调用|再次收尾|再调/); // 修掉后重调
    expect(out).toContain('说明'); // 保留要向用户说明
    // 修改路不重灌 rawPlan（决策 2：AI 当前会话看得到原标注）
    expect(out).not.toContain('原始任务意图');
  });

  it('page=null 的结构项归"deck 整体"段、不丢（决策 6 注）', () => {
    const out = buildRefeedText([
      { page: null, kind: 'structure', message: '未找到任何 slide' },
      { page: 4, kind: 'overflow', message: '溢出' },
    ]);
    const idxStructure = out.indexOf('deck 整体');
    const idxPage = out.indexOf('第 4 页');
    expect(idxStructure).toBeGreaterThan(-1);
    expect(idxStructure).toBeLessThan(idxPage); // 结构项排在最前
    expect(out).toContain('【结构契约】');
  });
});

describe('residualNote', () => {
  it('中性标注：不臆断原因、带清单、明确可要求再改', () => {
    const out = residualNote(ERRORS);
    expect(out).toContain('可能为有意保留');
    expect(out).toContain('可能未及修复');
    expect(out).toContain('第 16 页');
    expect(out).toMatch(/可要求其再改|如需处理/);
    // 不撒谎、不臆断：旧的一刀切 / 编故事措辞都不能出现
    expect(out).not.toContain('已反复修复仍未通过');
    expect(out).not.toContain('模型评估后保留');
  });
});
