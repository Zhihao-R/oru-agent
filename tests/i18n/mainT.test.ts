/**
 * 主进程取词 t()（D3）——按显式 lang 取词 + 插值；个体名经 {{name}} 注入、无名回落物种名 Oru。
 */
import { describe, it, expect } from 'vitest';
import { t } from '../../electron/main/i18n/t';

describe('主进程 t()', () => {
  it('审批拒绝理由：按 lang 取词 + {{tool}}/{{name}} 插值', () => {
    const zh = t('main:approval.readonlyToolBlocked', 'zh', { tool: 'Edit', name: '阿果' });
    expect(zh).toContain('只读');
    expect(zh).toContain('Edit');
    expect(zh).toContain('阿果');
    expect(zh).toContain('「工作」挡');

    const en = t('main:approval.readonlyWriteDenied', 'en', { tool: 'Edit', name: '阿果' });
    expect(en).toContain('Read-only mode is on');
    expect(en).toContain('switch 阿果 to Work mode');
  });

  it('无活跃 agent：回落物种名 Oru，不带个体名插值', () => {
    expect(t('main:scheduled.noActiveAgent', 'zh')).toBe('无活跃 Oru，无法触发定时任务');
    expect(t('main:scheduled.noActiveAgent', 'en')).toBe("No active Oru — can't trigger the scheduled task");
  });

  it('xlsx 预览失败回执文案：按 owner 语言 + 插值', () => {
    expect(t('main:xlsxPreview.noData', 'zh')).toBe('该文件中没有发现数据');
    expect(t('main:xlsxPreview.noData', 'en')).toBe('No data found in this file');
    expect(t('main:xlsxPreview.notFound', 'zh', { path: 'a/b.xlsx' })).toBe('文件不存在：a/b.xlsx');
    expect(t('main:xlsxPreview.notFound', 'en', { path: 'a/b.xlsx' })).toBe('File not found: a/b.xlsx');
    expect(t('main:xlsxPreview.readFailed', 'zh', { reason: 'bad zip' })).toContain('bad zip');
    expect(t('main:xlsxPreview.readFailed', 'en', { reason: 'bad zip' })).toContain('bad zip');
  });

  it('git 提示（SystemNote 直接渲染）：接个体名', () => {
    expect(t('main:gitHint', 'zh', { name: '阿果' })).toContain('阿果 的改动');
    expect(t('main:gitHint', 'en', { name: '阿果' })).toContain("阿果's changes");
  });

  it('平台远程回执（发给飞书/Discord 用户）：按 owner 语言', () => {
    expect(t('main:platform.bindSuccess', 'zh')).toContain('绑定成功');
    expect(t('main:platform.bindSuccess', 'en')).toContain('Binding successful');
    expect(t('main:platform.approvalBlocked', 'zh')).toContain('/mode danger'); // 出路给出可直接照打的命令
    expect(t('main:platform.approvalBlocked', 'en')).toContain('/mode danger');
    expect(t('main:platform.modeSwitched', 'zh', { mode: '危险挡' })).toContain('危险挡');
    expect(t('main:platform.modeSwitched', 'en', { mode: 'Danger' })).toContain('Danger');
    expect(t('main:platform.modeUsage', 'zh')).toContain('/mode danger');
    expect(t('main:platform.modeUsage', 'en')).toContain('/mode danger');
    expect(t('main:platform.unsupportedMessage', 'zh')).toContain('文字和图片');
    expect(t('main:platform.unsupportedMessage', 'en')).toContain('text and images');
    expect(t('main:platform.imageFailed', 'zh')).toContain('重发');
    expect(t('main:platform.imageFailed', 'en')).toContain('resend');
    expect(t('main:platform.visionUnsupported', 'zh')).toContain('不支持看图');
    expect(t('main:platform.visionUnsupported', 'en')).toContain("can't view images");
  });
});
