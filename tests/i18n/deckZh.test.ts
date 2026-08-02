// @vitest-environment node

/** 第 2 期·deck 命名空间「中文文案快照基线」。纯抽取，验收"中文界面一字不变"。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

describe('deck zh 文案快照', () => {
  it('历史版本窗口（kind 映射、时间格式、改动页插值）', () => {
    expect(i18n.t('deck:history.kind.initial')).toBe('初始版本');
    expect(i18n.t('deck:history.kind.ai')).toBe('Oru 改动');
    expect(i18n.t('deck:history.today', { hm: '09:30' })).toBe('今天 09:30');
    expect(i18n.t('deck:history.date', { month: 6, day: 5, hm: '09:30' })).toBe('6月5日 09:30');
    expect(i18n.t('deck:history.changedPages', { pages: '1、3' })).toBe('改动了第 1、3 页');
    expect(i18n.t('deck:history.title')).toBe('历史版本');
    expect(i18n.t('deck:history.thisOldVersion', { time: '今天 09:30' })).toBe('这个旧版 · 今天 09:30');
    expect(i18n.t('deck:history.thumbAlt', { n: 2 })).toBe('版本缩略图 2');
  });

  it('artifactStore adopt 兜底（FileTree alert 显示；export 兜底复用 controls.export.failed）', () => {
    expect(i18n.t('deck:adoptFailed')).toBe('加入演示稿失败');
  });

  it('预览工具栏 / 导出菜单（格式 label/hint、清晰度、失败插值、选清晰度）', () => {
    // 改前/改后、同步/已更新 是跨 viewer 预览原语，已提升到 common:compare/sync（见 commonZh）
    expect(i18n.t('deck:controls.export.htmlInline.label')).toBe('HTML · 单文件');
    expect(i18n.t('deck:controls.export.htmlInline.hint')).toBe('图片字体内联，双击即开、可分享');
    expect(i18n.t('deck:controls.export.pdf.label')).toBe('PDF');
    expect(i18n.t('deck:controls.scale.hd.label')).toBe('高清');
    expect(i18n.t('deck:controls.export.failed')).toBe('导出失败');
    expect(i18n.t('deck:controls.export.failedWith', { message: '超时' })).toBe('导出失败：超时');
    expect(i18n.t('deck:controls.export.pickScale', { format: 'PDF' })).toBe('PDF · 选择清晰度');
  });

  it('导出进度 / 更新确认 / 大纲 / 列表 / 空态（计数插值）', () => {
    expect(i18n.t('deck:exportProgress.title', { format: 'PPT' })).toBe('正在导出 PPT');
    expect(i18n.t('deck:exportProgress.pageCount', { done: 3, total: 10 })).toBe('3 / 10 页');
    expect(i18n.t('deck:updateAnnots.title', { count: 2 })).toBe('这份 deck 上还有 2 处标注没处理');
    expect(i18n.t('deck:center.generate')).toBe('从文稿生成演示设计');
    expect(i18n.t('deck:center.update')).toBe('更新演示设计');
    expect(i18n.t('deck:outline.pageTitle', { n: 4 })).toBe('第 4 页');
    expect(i18n.t('deck:list.heading')).toBe('演示稿');
    expect(i18n.t('deck:emptyState.nothing')).toBe('这里还什么都没有');
    expect(i18n.t('deck:narrative.loading')).toBe('载入中…');
  });
});
