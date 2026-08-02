// @vitest-environment node

/** pdf 命名空间（PDF 查看器：工具栏 / 搜索 / 错误态）「中文文案快照基线」。复数走 _one/_other。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('pdf zh 文案快照', () => {
  it('工具栏（页码插值 / 缩放 / 适配宽度）', () => {
    expect(t('pdf:loading')).toBe('正在加载 PDF…');
    expect(t('pdf:page.indicator', { current: 3, total: 12 })).toBe('第 3 页 / 共 12 页');
    expect(t('pdf:zoom.out')).toBe('缩小');
    expect(t('pdf:zoom.in')).toBe('放大');
    expect(t('pdf:zoom.fitWidth')).toBe('适配宽度');
  });

  it('搜索（占位 / 计数插值 / 无匹配）', () => {
    expect(t('pdf:search.placeholder')).toBe('在文档中搜索');
    expect(t('pdf:search.count', { current: 2, count: 7 })).toBe('2 / 7 处');
    expect(t('pdf:search.none')).toBe('无匹配');
  });

  it('错误态（损坏 / 加密）', () => {
    expect(t('pdf:error.corrupt')).toBe('文件已损坏，无法打开');
    expect(t('pdf:error.encrypted')).toBe('受密码保护的 PDF 暂不支持');
  });
});
