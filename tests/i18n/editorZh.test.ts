// @vitest-environment node

/** 第 2 期·editor 命名空间「中文文案快照基线」。
 *  含 React 组件（历史窗/导出/裁剪/工具条）与 CM widget（冲突卡/图片工具条/表格，非 React 走 i18n 单例 i18n.t('editor:...')）。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('editor zh 文案快照', () => {
  it('历史版本窗（kind 动态键、时间格式、各态文案）', () => {
    expect(t('editor:history.kind.periodic')).toBe('自动保存');
    expect(t('editor:history.kind.manual')).toBe('手动保存');
    expect(t('editor:history.kind.ai')).toBe('Oru 改动');
    expect(t('editor:history.kind.pre-restore')).toBe('恢复前保存');
    expect(t('editor:history.kind.initial')).toBe('初始版本');
    expect(t('editor:history.kindFallback')).toBe('版本');
    expect(t('editor:history.today', { hm: '09:30' })).toBe('今天 09:30');
    expect(t('editor:history.date', { month: 6, day: 5, hm: '09:30' })).toBe('6月5日 09:30');
    expect(t('editor:history.title')).toBe('历史版本');
    expect(t('editor:history.description')).toBe(
      '挑一个更早的时间点，把整篇恢复回来。自动保存的旧版软件关了、崩了也还在。',
    );
    expect(t('editor:history.clear')).toBe('清空历史');
    expect(t('editor:history.restore')).toBe('恢复此版本');
    expect(t('editor:history.empty')).toBe('还没有历史版本。改动一会儿后会自动保存。');
    expect(t('editor:history.pickPrompt')).toBe('选左边一个时间点，看它和现在的差异。');
    expect(t('editor:history.oldVersion')).toBe('这个旧版');
    expect(t('editor:history.now')).toBe('现在');
  });

  it('导出/裁剪/工具条（失败与缺图插值、PDF 也走 t）', () => {
    expect(t('editor:exportFailed')).toBe('导出失败');
    expect(t('editor:exportFailedWith', { error: '磁盘满' })).toBe('导出失败：磁盘满');
    expect(t('editor:exportMissing', { count: 2 })).toBe('已导出，但 2 张本地图片未找到');
    expect(t('editor:cancelExport')).toBe('取消导出');
    expect(t('editor:historyTitle')).toBe('历史版本');
    expect(t('editor:exportMenu.html')).toBe('HTML（单文件）');
    expect(t('editor:exportMenu.pdf')).toBe('PDF');
    expect(t('editor:exportMenu.paperMode')).toBe('纸张版（A4）');
    expect(t('editor:crop.title')).toBe('裁剪图片');
    expect(t('editor:crop.confirm')).toBe('裁剪');
    expect(t('editor:addToChat')).toBe('加入对话');
  });

  it('CM widget（冲突卡三动作 / 图片工具条 / 表格增删，单例直调键）', () => {
    expect(t('editor:conflict.mineLabel')).toBe('你的改动');
    expect(t('editor:conflict.theirsLabel')).toBe('Oru 的改动');
    expect(t('editor:conflict.useMine')).toBe('用我的');
    expect(t('editor:conflict.useTheirs')).toBe('用 Oru 的');
    expect(t('editor:conflict.keepBoth')).toBe('两个都留');
    expect(t('editor:img.missing')).toBe('图片缺失');
    expect(t('editor:img.alignLeftTitle')).toBe('左对齐');
    expect(t('editor:img.sizeMediumTitle')).toBe('中');
    expect(t('editor:img.sizeOrigTitle')).toBe('原始大小');
    expect(t('editor:img.crop')).toBe('裁剪');
    expect(t('editor:img.cropTitle')).toBe('裁剪');
    expect(t('editor:table.insertColLeft')).toBe('在左侧插入列');
    expect(t('editor:table.deleteRow')).toBe('删除本行');
    expect(t('editor:table.insertRowBelow')).toBe('在下方插入行');
  });
});
