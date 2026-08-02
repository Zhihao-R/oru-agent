// @vitest-environment node

/** 第 2 期·conversation 命名空间（左栏对话列表 + 共享时间分段标签）「中文文案快照基线」。
 *  bucket 标签由 conversationBuckets.bucketLabel 与 scheduledTask 选择器共用（conversation: 前缀键）。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('conversation zh 文案快照', () => {
  it('时间分段标签（原 BUCKET_LABEL/ARCHIVED_LABEL 归一）', () => {
    expect(t('conversation:bucket.today')).toBe('今天');
    expect(t('conversation:bucket.week')).toBe('本周');
    expect(t('conversation:bucket.earlier')).toBe('更早');
    // archived 与 bucket 同走 bucketLabel 统一范式（键并入 bucket 组）
    expect(t('conversation:bucket.archived')).toBe('已归档');
  });

  it('列表头部/空态/搜索（称呼收敛：加载态接个体名）', () => {
    expect(t('conversation:loading', { name: '阿果' })).toBe('阿果 加载中…');
    expect(t('conversation:newConv')).toBe('新对话');
    expect(t('conversation:searchAria')).toBe('搜索');
    expect(t('conversation:searchPlaceholder')).toBe('搜标题和聊天内容…');
    expect(t('conversation:empty')).toBe('还没有对话');
    expect(t('conversation:searching')).toBe('搜索中…');
    expect(t('conversation:noResults', { query: '预算' })).toBe('没有命中「预算」的对话');
  });

  it('归档/删除确认（title 插值、兜底版、多行 desc）', () => {
    expect(t('conversation:archiveTitle', { title: '周报' })).toBe('归档「周报」');
    expect(t('conversation:archiveTitleFallback')).toBe('归档对话');
    expect(t('conversation:archiveBody')).toBe('将归档此对话，若需彻底删除，请前往「已归档」区进行操作。');
    expect(t('conversation:dontAskAgain')).toBe('不再提醒，以后直接归档');
    expect(t('conversation:deleteTitle', { title: '草稿' })).toBe('彻底删除「草稿」？');
    expect(t('conversation:deleteTitleFallback')).toBe('彻底删除？');
    expect(t('conversation:deletePermanent')).toBe('彻底删除');
    expect(t('conversation:deleteDesc')).toBe('此对话将被永久删除，无法在应用内恢复（聊天记录仍以 .bak 文件保留在磁盘）。');
  });

  it('搜索摘要 Trans（<b> 计数）/ 角色 / 状态点三态 / aria', () => {
    // <b> 由组件注入，文案值含 <b>{{convs}}</b> 标记
    expect(t('conversation:searchSummary')).toBe('<b>{{convs}}</b> 个对话 · <b>{{hits}}</b> 处命中');
    expect(t('conversation:roleUser')).toBe('你');
    expect(t('conversation:badgeTodo')).toBe('有要你处理的');
    expect(t('conversation:badgeRunning')).toBe('进行中');
    expect(t('conversation:badgeUnread')).toBe('有未验收的完成');
    expect(t('conversation:renameAria', { title: 'X' })).toBe('重命名 X');
    expect(t('conversation:deleteAria', { title: 'X' })).toBe('彻底删除 X');
    expect(t('conversation:archiveAria', { title: 'X' })).toBe('归档 X');
  });
});
