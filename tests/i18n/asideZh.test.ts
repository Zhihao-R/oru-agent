// @vitest-environment node

/** 第 2 期·aside 命名空间（随手评点：指代解析 label + deck 点击 label + 浮层 AsideOverlay）「中文文案快照基线」。
 *  只翻 label（人面向：指代卡/归档标题）；referent 的 context/surround（speakerOf、前文/后文、文稿大纲）
 *  喂给 AI(class③) 原样不翻、不在本 ns；overlayMachine 的中文全是 console.warn 不抽。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('aside zh 文案快照', () => {
  it('指代档 label（resolve.ts / deckClick.ts，分隔符拆分后逐字一致）', () => {
    expect(t('aside:msgLabel')).toBe('消息');
    expect(t('aside:aMessage')).toBe('一条消息');
    expect(t('aside:controlLabel')).toBe('控件');
    expect(t('aside:uiControl')).toBe('界面控件');
    expect(t('aside:chatArea')).toBe('对话区');
    expect(t('aside:uiBlank')).toBe('界面空白处');
    expect(t('aside:pageLabel', { n: 3 })).toBe('第 3 页');
    expect(t('aside:narrativePreview')).toBe('文稿预览');
    // 渲染端合成：`${msgLabel} · “${text}”` / `${pageLabel} · ${title}`
    expect(`${t('aside:msgLabel')} · “选段”`).toBe('消息 · “选段”');
    expect(`${t('aside:pageLabel', { n: 3 })} · 封面`).toBe('第 3 页 · 封面');
  });

  it('浮层 AsideOverlay（placeholder/title/三种报错插值）', () => {
    expect(t('aside:placeholder')).toBe('接着聊…');
    expect(t('aside:promoteTitle')).toBe('去对话深聊');
    expect(t('aside:errReply', { error: '超时' })).toBe('没能回上话：超时');
    expect(t('aside:errBegin', { error: '网络' })).toBe('没能开始对话：网络');
    expect(t('aside:errPromote', { error: '繁忙' })).toBe('没能去对话：繁忙');
  });

  it('窗外指代兜底（overlay 无前台 app 名时 label = 屏幕）', () => {
    expect(t('aside:screen')).toBe('屏幕');
  });
});
