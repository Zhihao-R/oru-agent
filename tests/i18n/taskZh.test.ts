// @vitest-environment node

/** 第 2 期·task 命名空间（agent 任务卡：运行/终态/问答气泡）「中文文案快照基线」。"Twin" 名字原样保留。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('task zh 文案快照', () => {
  it('运行中卡（状态词含 Twin、分支/取消插值）', () => {
    expect(t('task:awaitingUser')).toBe('等你回答');
    expect(t('task:awaitingTwin', { name: '阿果' })).toBe('等 阿果 答中…'); // 称呼收敛：接个体名
    expect(t('task:queued')).toBe('准备中…');
    expect(t('task:branch', { branch: 'feat/x' })).toBe('分支: feat/x');
    expect(t('task:cancelConfirm')).toBe('取消这个任务？工作树会自动回滚到任务开始前。');
    expect(t('task:cancelFailedWith', { error: '超时' })).toBe('取消失败：超时');
    expect(t('task:terminalPlaceholder', { title: '改首页', status: 'done' })).toBe('任务 改首页 已 done');
  });

  it('升级 banner（EscalationBanner：单条带标题插值 / 多条带计数）', () => {
    expect(t('task:escalation.oneAsking', { title: '改首页' })).toBe('任务 "改首页" 等你回答');
    expect(t('task:escalation.manyAsking', { count: 3 })).toBe('3 个任务等你回答');
    expect(t('task:escalation.jumpHint')).toBe('点击跳转');
  });

  it('终态卡（撤回确认两版多行串、项目/commit 插值）', () => {
    expect(t('task:rollbackConfirmCommits', { title: '改样式', count: 2 })).toBe(
      '撤回任务 "改样式"？\n\n这会创建 2 条 revert commit（保留 git history）。',
    );
    expect(t('task:rollbackConfirmBaseline', { title: '改样式' })).toBe(
      '撤回任务 "改样式"？\n\n会反向应用本任务的改动到 baseline。',
    );
    expect(t('task:inProject', { project: '我的项目' })).toBe('在项目 我的项目 里执行'); // {{project}}≠agent {{name}}，避免 task ns 内 {{name}} 重载
    expect(t('task:committed', { count: 3 })).toBe('已 commit (3 条)');
    expect(t('task:rollback')).toBe('撤回');
  });

  it('问答气泡（用户原话引用、Twin 加工提示、角色 label）', () => {
    // 称呼收敛：Twin → 个体名（userOriginalQuote 同时有 answer + name 两个插值）
    expect(t('task:userOriginalQuote', { answer: '用方案 A', name: '阿果' })).toBe('（你原话："用方案 A"，阿果 加工后给子 agent）');
    expect(t('task:answerPlaceholder', { name: '阿果' })).toBe('回答 阿果 转给你的问题（Cmd+Enter 提交）');
    expect(t('task:twinProcessHint', { name: '阿果' })).toBe('阿果 会把你的回答加工成清晰指令再发给子 agent');
    expect(t('task:roleSubagent')).toBe('子 agent');
    expect(t('task:roleUser')).toBe('你');
    expect(t('task:answerFailedWith', { error: 'net' })).toBe('回答失败: net');
  });
});
