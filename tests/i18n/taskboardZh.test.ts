// @vitest-environment node

/**
 * 第 2 期·taskboard 命名空间「中文文案快照基线」。
 * 关键：BoardTaskStatus 值即中文枚举（数据），statusLabel 只翻显示 label、用 latin key 映射。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n, type TFunction } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';
import { statusLabel } from '@/components/taskboard/statusLabel';

let i18n: I18n;
let tb: TFunction;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
  tb = i18n.getFixedT('zh', 'taskboard');
});

describe('taskboard zh 文案快照', () => {
  it('statusLabel：枚举值（数据）→ 显示 label 逐字还原', () => {
    expect(statusLabel('待办', tb)).toBe('待办');
    expect(statusLabel('进行中', tb)).toBe('进行中');
    expect(statusLabel('待验收', tb)).toBe('待验收');
    expect(statusLabel('已完成', tb)).toBe('已完成');
  });

  it('状态徽章 tooltip（label 插值）', () => {
    expect(i18n.t('taskboard:statusBadge.tooltip', { label: '进行中' })).toBe('状态：进行中');
    expect(i18n.t('taskboard:statusBadge.tooltipClickable', { label: '待办' })).toBe('状态：待办（点击切换）');
  });

  it('归属标签（you/oru，oru 保留产品名）', () => {
    expect(i18n.t('taskboard:assignee.you')).toBe('你');
    expect(i18n.t('taskboard:assignee.oru')).toBe('Oru');
  });

  it('分组标题 / 列表计数与空态（插值）', () => {
    expect(i18n.t('taskboard:group.oru')).toBe('Oru 的');
    expect(i18n.t('taskboard:group.tag', { tag: '前端' })).toBe('# 前端');
    expect(i18n.t('taskboard:list.taskCount', { count: 5 })).toBe('5 个任务');
    expect(i18n.t('taskboard:list.hiddenCompleted', { count: 3 })).toBe('(3 条历史已完成已隐藏)');
    expect(i18n.t('taskboard:list.empty')).toBe('这里还没有任务。点左上角 + 新建，或在主聊天里让 Oru 帮你建。');
    expect(i18n.t('taskboard:oruThinking')).toBe('Oru 思考中…');
  });

  it('侧栏 / 新建对话框 / 评论输入', () => {
    expect(i18n.t('taskboard:sidebar.recycleBin')).toBe('回收站');
    expect(i18n.t('taskboard:newTask.saveEnter')).toBe('保存 ⏎');
    expect(i18n.t('taskboard:newTask.titlePlaceholder')).toBe('一句话说清楚要做什么');
    expect(i18n.t('taskboard:comment.placeholder')).toBe('写一条评论…（输入 @oru 召唤 Oru；回车发送，Shift+Enter 换行）');
    expect(i18n.t('taskboard:comment.sendHint')).toBe('回车发送，Shift+Enter 换行');
  });

  it('Oru 回复注脚（写操作插值）/ 回收站', () => {
    expect(i18n.t('taskboard:reply.created', { title: '写周报' })).toBe('已新建任务「写周报」');
    expect(i18n.t('taskboard:reply.updated', { id: 'abc123', patch: 'status / title' })).toBe(
      '已修改任务 #abc123：status / title',
    );
    expect(i18n.t('taskboard:reply.processNote', { note: '已删除任务 #x（进回收站）' })).toBe(
      '── 过程中：已删除任务 #x（进回收站）',
    );
    expect(i18n.t('taskboard:recycle.count', { count: 4 })).toBe('4 条');
    expect(i18n.t('taskboard:recycle.deletedBy', { actor: '你' })).toBe('删除人 你');
    expect(i18n.t('taskboard:comment.contextCompressed')).toBe('📦 上下文已压缩');
  });

  it('任务详情（日期格式 / 字段标签 / 加载失败插值）', () => {
    expect(i18n.t('taskboard:detail.dateFormat', { month: 6, day: 25, time: '14:30' })).toBe(
      '6月25日 14:30',
    );
    expect(i18n.t('taskboard:detail.propCreated')).toBe('创建');
    expect(i18n.t('taskboard:detail.loadFailedMsg', { message: '网络错误' })).toBe('加载失败：网络错误');
    expect(i18n.t('taskboard:detail.deleteConfirm')).toBe('任务进入回收站，可随时恢复。');
    expect(i18n.t('taskboard:detail.descSaveHint')).toBe('⌘/Ctrl+Enter 保存 · Esc 撤销');
  });
});
