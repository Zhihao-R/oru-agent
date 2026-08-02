// @vitest-environment node

/** 第 2 期·notification 命名空间（通知中心 AgentTaskPanel）「中文文案快照基线」。"Oru" 名字原样保留。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('notification zh 文案快照', () => {
  it('标题 / 三段标签 / 空与安抚态（含 "Oru" 名字保留）', () => {
    expect(t('notification:title')).toBe('通知');
    expect(t('notification:needAction')).toBe('需要你处理');
    expect(t('notification:done')).toBe('完成');
    expect(t('notification:running')).toBe('进行中');
    expect(t('notification:allClear')).toBe('没有要你处理的事，Oru 这边都妥了。');
    expect(t('notification:emptyNoTasks')).toBe(
      '还没有任务记录。让 Oru 改点东西、或排一个定时任务，跑起来就会出现在这里。',
    );
  });

  it('行内动作 / 计数插值 / 进行中文案', () => {
    expect(t('notification:retry')).toBe('重试');
    expect(t('notification:ignore')).toBe('忽略');
    expect(t('notification:stop')).toBe('停止');
    expect(t('notification:interrupted')).toBe('执行中断');
    expect(t('notification:missedScheduled')).toBe('错过的定时任务');
    expect(t('notification:runningFootnote', { count: 2 })).toBe('另外还有 2 个子任务在跑。');
    expect(t('notification:moreDone', { count: 5 })).toBe('还有 5 条已完成…');
    expect(t('notification:taskRunning')).toBe('运行中…');
    expect(t('notification:oruReplying')).toBe('Oru 正在回复…');
  });
});
