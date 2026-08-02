// @vitest-environment node

/** 第 2 期·annot 命名空间（批注面板 + 框选卡）「中文文案快照基线」。
 *  prefillIntro（提交修改时预填进 composer 的引导语）随界面语言——用户拍板的种子内容先例；
 *  用户写的标注 comment 是数据，原样不翻（不在本 ns）。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('annot zh 文案快照', () => {
  it('面板头部/框选/提交/空态/预填引导语', () => {
    expect(t('annot:heading')).toBe('批注');
    expect(t('annot:collapseTitle')).toBe('收起批注栏');
    expect(t('annot:frameSelect')).toBe('框选');
    expect(t('annot:frameSelectTitle')).toBe('在预览里拖一个框圈出要改的区域');
    expect(t('annot:submit')).toBe('提交修改');
    expect(t('annot:empty')).toBe('还没有标注——在预览里框选要改的区域');
    expect(t('annot:prefillIntro')).toBe('按照我的标注进行修改');
    expect(t('annot:submitConflict')).toBe('已有未完成的提交组，先保存或取消上一组再提交');
    expect(t('annot:pickConvFirst')).toBe('请先选择一个对话再继续');
  });

  it('提交组状态/说明/按钮（residual 计数插值）', () => {
    expect(t('annot:status.interrupted')).toBe('已中断');
    expect(t('annot:status.editing')).toBe('修改中');
    expect(t('annot:status.done')).toBe('完成');
    expect(t('annot:status.narrativeUpdate')).toBe('据文稿更新');
    expect(t('annot:interruptedDesc')).toBe(
      '上次这批标注提交后 AI 改了一半被中断。「继续」切回原对话、在当前稿子上接着改；「退回改前」回到提交前。',
    );
    expect(t('annot:narrativeEditing')).toBe('按你这次改的部分，在最新内容上对齐叙事——改动可能遍及多页。');
    expect(t('annot:narrativeDone')).toBe('改动可能遍及多页，点「对比」查看；这次提交没有框选标注。');
    expect(t('annot:allDone')).toBe('本次修改已全部完成');
    expect(t('annot:resume')).toBe('继续');
    expect(t('annot:revertToBefore')).toBe('退回改前');
    expect(t('annot:stopEditing')).toBe('停止修改');
    expect(t('annot:markDone')).toBe('标记完成');
    expect(t('annot:residual', { count: 3 })).toBe('AI 报告仍有 3 处客观问题——可点「对比」核对或「取消」回到改前');
    expect(t('annot:compare')).toBe('对比');
    expect(t('annot:exitCompare')).toBe('退出对比');
  });

  it('框选卡（页码插值/占位/无截图）', () => {
    expect(t('annot:jumpTitle')).toBe('跳到标注位置');
    expect(t('annot:pageLabel', { n: 4 })).toBe('第 4 页');
    expect(t('annot:deleteTitle')).toBe('删除这条标注');
    expect(t('annot:noComment')).toBe('（无注释）');
    expect(t('annot:commentPlaceholder')).toBe('写注释……');
    expect(t('annot:noCrop')).toBe('无截图');
  });
});
