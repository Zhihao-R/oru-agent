// @vitest-environment node

/** pages + memory 命名空间中文文案快照基线。主页手账入口/画像描述已称呼收敛（接个体名 {{name}}）。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';
import { CATEGORY_LABELS } from '@shared/types';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

describe('pages / memory zh 文案快照', () => {
  it('主页（称呼收敛：手账入口/画像描述接个体名 {{name}}，切换失败插值）', () => {
    expect(i18n.t('pages:home.title')).toBe('主页');
    expect(i18n.t('pages:home.journal', { name: '阿果' })).toBe('阿果 手账');
    expect(i18n.t('pages:home.subtitle', { name: '阿果' })).toBe('所有项目当前状态 + 阿果 手账入口');
    expect(i18n.t('pages:home.journalDesc', { name: '阿果' })).toBe('阿果 关于你的累积理解、偏好、事实、最近记录');
    expect(i18n.t('pages:home.switchFailed', { error: '超时' })).toBe('切换项目失败：超时');
    expect(i18n.t('pages:home.noProgress', { name: '阿果' })).toBe(
      '(还没写过 progress——下次跟 阿果 聊到这个项目时它会自动维护)',
    );
  });

  it('开发者页（调试面板 / Prompt 工作台）', () => {
    expect(i18n.t('pages:debug.loggingOff')).toBe(
      '调试日志已关闭——以下为历史记录，新对话不会被记录。前往「设置 → 开发者模式」可重新开启。',
    );
    expect(i18n.t('pages:debug.loadingTimeline')).toBe('载入中…');
    expect(i18n.t('pages:debug.retentionHint')).toBe('仅保留最近 7 天，更早的自动清理');
    expect(i18n.t('pages:bench.title')).toBe('Prompt 工作台');
  });

  it('Prompt 工作台组件（Playground/PromptList/PromptViewer，含插值；载入态复用 app:loading）', () => {
    expect(i18n.t('pages:bench.noModels')).toBe('（暂无可用模型，先去设置添加）');
    expect(i18n.t('pages:bench.systemContextLabel')).toBe('System 上下文（临时改，不落盘）');
    expect(i18n.t('pages:bench.reset')).toBe('重置原文');
    expect(i18n.t('pages:bench.yourInput')).toBe('你的输入');
    expect(i18n.t('pages:bench.inputPlaceholder')).toBe('给它说一句话…');
    expect(i18n.t('pages:bench.running')).toBe('运行中…');
    expect(i18n.t('pages:bench.run')).toBe('运行');
    expect(i18n.t('pages:bench.runFailed', { error: '超时' })).toBe('运行失败：超时');
    expect(i18n.t('pages:bench.resetTitle')).toBe('重置为该段原文');
    expect(i18n.t('pages:bench.viewerEmpty')).toBe('在左栏选一段 prompt 查看');
    expect(i18n.t('pages:bench.loadFailed', { error: 'ENOENT' })).toBe('加载失败：ENOENT');
    expect(i18n.t('pages:bench.empty')).toBe('暂无登记的 prompt。');
    expect(i18n.t('app:loading')).toBe('载入中…'); // PromptList/PromptViewer 载入态复用
  });

  it('Prompt 类目标签（pages:bench.category.*，渲染端按 PromptCategory 取词）', () => {
    expect(i18n.t('pages:bench.category.persona')).toBe('人格');
    expect(i18n.t('pages:bench.category.memory')).toBe('记忆');
    expect(i18n.t('pages:bench.category.agent')).toBe('Agent');
    expect(i18n.t('pages:bench.category.tasks')).toBe('任务');
    expect(i18n.t('pages:bench.category.taskboard')).toBe('任务面板');
    // 完整性：遍历 PromptCategory 全集（用 CATEGORY_LABELS 的 keys 作运行时来源，不依赖其值）——加类目漏配即红。
    // 注：CATEGORY_LABELS 的中文值在渲染端 i18n 化后已无生产消费方（registry 仅 re-export、PromptList 仅用 keys）；
    // 其结构收敛 + 主进程 i18n 留第 4 期（见 glossary 待办）。
    for (const cat of Object.keys(CATEGORY_LABELS)) {
      expect(i18n.t(`pages:bench.category.${cat}`), `category.${cat} 缺译文`).not.toBe(`bench.category.${cat}`);
    }
  });

  it('手账页（name/date 插值，月日带空格）', () => {
    expect(i18n.t('memory:journalTitle', { name: 'Oru' })).toBe('Oru 手账');
    expect(i18n.t('memory:aboutSelf', { name: 'Oru' })).toBe('关于 Oru 自己');
    expect(i18n.t('memory:colophonDate', { month: 6, day: 25 })).toBe('6 月 25 日');
    expect(i18n.t('memory:colophon', { name: 'Oru', date: '6 月 25 日' })).toBe('Oru 写于 6 月 25 日');
    expect(i18n.t('memory:userChar')).toBe('你');
  });

  it('笔记区（episode 类型 label、筛选、校对依据插值）', () => {
    expect(i18n.t('memory:episodeType.user')).toBe('事实');
    expect(i18n.t('memory:episodeType.agent')).toBe('反思');
    expect(i18n.t('memory:events.heading')).toBe('笔记');
    expect(i18n.t('memory:events.retiredCount', { count: 3 })).toBe('已整理掉 3 条');
    expect(i18n.t('memory:events.predecessor')).toBe('之前你是这么想的');
    expect(i18n.t('memory:events.correctedNote', { date: '06-20' })).toBe(
      '06-20 dream 校对过这条；明细见下方「整理记录」。',
    );
  });

  it('整理记录 / 画像 / 项目附录（凌晨日期、明细计数、空态）', () => {
    expect(i18n.t('memory:nightlog.dateLabel', { month: 6, day: 5 })).toBe('6 月 5 日凌晨');
    expect(i18n.t('memory:nightlog.details', { count: 4 })).toBe('明细（4 笔）');
    // 记忆两区改名：事实→基本情况、散文画像→特质叙述、人设→自我；称呼接个体名 {{name}}
    expect(i18n.t('memory:facts.heading')).toBe('基本情况');
    expect(i18n.t('memory:portrait.heading')).toBe('特质叙述');
    expect(i18n.t('memory:portrait.empty', { name: '阿果' })).toBe('（阿果 还没写你的特质叙述——多聊几次后会出现）');
    expect(i18n.t('memory:self.empty', { name: '阿果' })).toBe('（阿果 还没写下自己是什么样——可以点 ✎ 写一份）');
    expect(i18n.t('memory:projects.heading')).toBe('正在做的项目');
    expect(i18n.t('memory:projects.noProgress')).toBe('（dream 还没整理这个项目的进度）');
  });
});
