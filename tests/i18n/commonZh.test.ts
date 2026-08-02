// @vitest-environment node

/** 第 2 期·common 命名空间「中文文案快照基线」。
 *  通用词（取消/保存/加载…）与相对时间格式化（formatRelativeTime 取词处）的中文一字不变基线。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('common zh 文案快照', () => {
  it('通用按钮/状态词', () => {
    expect(t('common:cancel')).toBe('取消');
    expect(t('common:save')).toBe('保存');
    expect(t('common:delete')).toBe('删除');
    expect(t('common:close')).toBe('关闭');
    expect(t('common:remove')).toBe('移除');
    expect(t('common:refresh')).toBe('刷新');
    expect(t('common:listSeparator')).toBe('、'); // 跨处列表拼接分隔符（en 为 ", "）
  });

  it('跨 viewer 预览原语（deck 预览 + HtmlViewer 共用，从 deck 提升而来）', () => {
    expect(t('common:compare.before')).toBe('改前');
    expect(t('common:compare.after')).toBe('改后');
    expect(t('common:sync.syncing')).toBe('正在同步…');
    expect(t('common:sync.updated')).toBe('已更新');
    expect(t('common:loading')).toBe('加载中…');
    expect(t('common:saving')).toBe('保存中…');
  });

  it('共用 ui 组件（DeleteConfirm 默认文案 / AttachmentGallery 缩放提示插值）', () => {
    expect(t('common:deleteConfirm.title')).toBe('确认删除？');
    expect(t('common:deleteConfirm.confirmLabel')).toBe('确认删除');
    expect(t('common:deleteConfirm.busyLabel')).toBe('删除中…');
    expect(t('common:attachment.zoomHint')).toBe('（点击放大）'); // 文件名由调用处拼接，不进文案 key
  });

  it('图片附件校验（imageAttachments，文件名/大小/数量插值；reason 经 alert 显示）', () => {
    expect(t('common:attachment.rejectFormat', { name: 'a.bmp' })).toBe('不支持的格式：a.bmp（仅 PNG / JPEG / GIF / WEBP）');
    expect(t('common:attachment.rejectSize', { name: 'big.png', size: '6.3' })).toBe('big.png 6.3 MB 超过单张 5 MB 上限');
    expect(t('common:attachment.countLimit', { max: 8, prev: 6, cur: 3 })).toBe('单条最多 8 张图（已有 6，本次 3）');
  });

  it('相对时间（formatRelativeTime 取词，{{count}} 插值，裸键命中）', () => {
    expect(t('common:relativeTime.justNow')).toBe('刚刚');
    expect(t('common:relativeTime.minutesAgo', { count: 5 })).toBe('5 分钟前');
    expect(t('common:relativeTime.hoursAgo', { count: 3 })).toBe('3 小时前');
    expect(t('common:relativeTime.daysAgo', { count: 2 })).toBe('2 天前');
  });
});
