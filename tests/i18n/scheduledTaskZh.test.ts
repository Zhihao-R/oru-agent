// @vitest-environment node

/**
 * 第 2 期·scheduledTask 批次的「中文文案快照基线」。
 *
 * 用真实 zh 资源（locales/zh/*.json）跑一个独立 i18next 实例，钉死抽取后 t() 渲染出的中文
 * 与抽取前组件里的硬编码原文**逐字一致**——尤其是插值串（{{x}} 写错 / 漏 param 会在此暴露）。
 * 这些期望值是从抽取前的组件源码逐字抄来的（中文零回退的可执行证据）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('scheduledTask zh 文案快照', () => {
  it('插值串逐字还原（抽取前的硬编码原文）', () => {
    expect(t('scheduledTask:missed.header', { total: 3 })).toBe('⚠ 错过待处理 · 3 项');
    expect(t('scheduledTask:missed.expandAll', { total: 7 })).toBe('展开查看全部 7 项 ▾');
    expect(t('scheduledTask:missed.original', { when: '昨天 09:00' })).toBe('原定 昨天 09:00');
    expect(t('scheduledTask:runLoc.inConversation', { title: '随手记' })).toBe('运行于「随手记」');
    expect(t('scheduledTask:compose.confirmOnce', { first: '今天 18:00' })).toBe(
      '将于 今天 18:00 触发一次，执行后从清单移除。',
    );
    expect(t('scheduledTask:compose.confirmRecurring', { first: '明天 08:00', frequency: '每天' })).toBe(
      '将于 明天 08:00 首次触发，频率：每天。',
    );
  });

  it('已结束分组小标题 + 未能触发原因文案', () => {
    expect(t('scheduledTask:ended.triggered')).toBe('已触发');
    expect(t('scheduledTask:ended.notTriggered')).toBe('未能触发');
    expect(t('scheduledTask:ended.expired')).toBe('设定时间已过，未执行');
    expect(t('scheduledTask:ended.dismissed')).toBe('你已忽略');
  });

  it('计时器/闹钟两模式 + 触发时间清单文案', () => {
    expect(t('scheduledTask:mode.timer')).toBe('计时器');
    expect(t('scheduledTask:mode.alarm')).toBe('闹钟');
    expect(t('scheduledTask:rule.addTrigger')).toBe('添加触发时间');
    expect(t('scheduledTask:rule.stopForever')).toBe('一直重复');
    expect(t('scheduledTask:rule.alarmSummary', { when: '每天 08:00', stop: '一直重复' })).toBe(
      '每天 08:00 触发，一直重复',
    );
    expect(t('scheduledTask:rule.onceFrozen', { when: '明天 08:00' })).toBe('已定在 明天 08:00 触发一次');
    expect(i18n.t('scheduledTask:weekdaysShort', { returnObjects: true })).toEqual([
      '日', '一', '二', '三', '四', '五', '六',
    ]);
  });

  it('样例种子内容（标题/描述/prompt）逐字还原', () => {
    expect(t('scheduledTask:samples.daily.title')).toBe('每日简报');
    expect(t('scheduledTask:samples.daily.desc')).toBe('每天 08:00');
    expect(t('scheduledTask:samples.daily.prompt')).toBe(
      '汇总我昨天的笔记和今天日历上的安排，生成一份今日简报',
    );
    expect(t('scheduledTask:samples.weekly.prompt')).toBe('扫一遍这个项目这周的改动，写一段周报草稿');
  });

  it('跨 namespace 复用的通用词（common）', () => {
    expect(t('common:cancel')).toBe('取消');
    expect(t('common:save')).toBe('保存');
    expect(t('common:delete')).toBe('删除');
  });

  it('代表性静态串', () => {
    expect(t('scheduledTask:pageTitle')).toBe('定时任务');
    expect(t('scheduledTask:empty.none')).toBe('还没有定时任务。到点自动替你做一件事，从这里开始。');
    expect(t('scheduledTask:compose.contentPlaceholder')).toBe(
      '用你对 Oru 说话的口吻写，比如「汇总我昨天的笔记，生成一份今日简报」',
    );
    expect(t('scheduledTask:compose.triggers')).toBe('触发时间');
  });

  it('自然语言格式化（scheduledTaskFormat：相对日 / 上次结果组合模板）', () => {
    expect(t('scheduledTask:format.today')).toBe('今天');
    expect(t('scheduledTask:format.tomorrow')).toBe('明天');
    expect(t('scheduledTask:format.afterTomorrow')).toBe('后天');
    expect(t('scheduledTask:format.yesterday')).toBe('昨天');
    expect(t('scheduledTask:format.dateMD', { month: 6, day: 5 })).toBe('6月5日');
    expect(t('scheduledTask:format.lastRunNever')).toBe('上次：尚未执行');
    expect(t('scheduledTask:format.resultOk')).toBe('✓ 成功');
    expect(t('scheduledTask:format.resultFailed')).toBe('✗ 失败');
    expect(t('scheduledTask:format.resultFailedWith', { error: '超时' })).toBe('✗ 失败（超时）');
    expect(t('scheduledTask:format.resultAborted')).toBe('⏹ 已中止');
    // 组合：describeLastRun 用 when/result 拼整行，逐字对齐原硬编码 `上次：${late?'补执行 ':''}${when} ${tail}`
    expect(t('scheduledTask:format.lastRun', { when: '明天 08:00', result: '✓ 成功' })).toBe('上次：明天 08:00 ✓ 成功');
    expect(t('scheduledTask:format.lastRunLate', { when: '今天 09:30', result: '✗ 失败（超时）' })).toBe(
      '上次：补执行 今天 09:30 ✗ 失败（超时）',
    );
  });
});
