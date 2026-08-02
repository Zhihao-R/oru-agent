// @vitest-environment node

/** 第 2 期·table 命名空间「中文文案快照基线」。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

describe('table zh 文案快照', () => {
  it('导入冲突 / 规范化弹窗（插值）', () => {
    expect(i18n.t('table:import.desc', { source: 'a.xlsx', target: 'a.csv' })).toBe(
      'a.xlsx 这次转换出的 a.csv 与目录里的现有文件内容不一致——可能被你手改过、AI 清洗过，或在 Excel 里动过。',
    );
    expect(i18n.t('table:import.queueMore', { count: 2 })).toBe('还有 2 个文件等待处理');
    expect(i18n.t('table:canonical.title')).toBe('文件不是规范 CSV 格式');
    expect(i18n.t('table:canonical.saveCopy')).toBe('另存规范副本');
  });

  it('xlsx 只读预览（插值）', () => {
    expect(i18n.t('table:preview.badge')).toBe('只读预览——原件未动，未生成任何文件');
    expect(i18n.t('table:preview.confirmTitle')).toBe('生成可编辑的 CSV？');
    expect(i18n.t('table:preview.confirmDesc')).toBe(
      'xlsx 不能直接编辑。确认后会在旁边生成对应的 CSV 并打开它编辑；xlsx 原件不动，之后两者各自独立。',
    );
    expect(i18n.t('table:preview.confirmOk')).toBe('生成并编辑');
  });

  it('CsvEditor：统计条 / 来源条（含 <em> 高亮标记）/ 右键菜单 / 筛选', () => {
    expect(i18n.t('table:csv.dims', { rows: '1,234', cols: 5 })).toBe('1,234 行 × 5 列');
    expect(i18n.t('table:csv.filtered', { shown: '10', total: '99' })).toBe('已筛选 10/99 行');
    expect(i18n.t('table:csv.statIgnored', { n: 3 })).toBe('已忽略 3 个非数字');
    expect(i18n.t('table:csv.colN', { n: 2 })).toBe('列2');
    expect(i18n.t('table:csv.totalRows', { count: '8,000' })).toBe('共 8,000 行数据');
    // 来源条经 <Trans> 渲染高亮 span，值里保留 <em> 标记（zh 原文加了结构标记不变内容）
    expect(i18n.t('table:csv.provBy', { script: 'clean.py' })).toBe('由 <em>clean.py</em> 生成');
    expect(i18n.t('table:csv.ctxDeleteRow')).toBe('删除行');
    expect(i18n.t('table:csv.tooManyValues', { cap: 500 })).toBe('值太多，只列前 500 个');
    expect(i18n.t('table:csv.emptyValue')).toBe('（空）');
  });

  it('补全覆盖：两种编码问题的描述、统计中、非 UTF-8 标、多脚本来源', () => {
    expect(i18n.t('table:csv.totalCounting')).toBe('共 统计中…');
    // 状态栏只标编码，不标风格：风格不规范会在下次保存时无损定型，标它等于指着一个没有动作可做的非问题
    expect(i18n.t('table:csv.nonUtf8')).toBe(' · 非 UTF-8 编码');
    expect(i18n.t('table:csv.provMulti', { scripts: 'a.py、b.py' })).toBe(
      '多个脚本都声明写出此文件：a.py、b.py（来源有歧义，建议整理）',
    );
    expect(i18n.t('table:csv.gbkDesc')).toBe(
      '这个文件是 GBK 编码。落盘会把它转成 UTF-8 规范格式；编码探测可能有误判，不放心就另存副本、原件不动。',
    );
    // BOM 文件的 encoding 仍是 'utf-8'，必须有自己的描述——落到风格文案上就是答非所问
    expect(i18n.t('table:csv.bomDesc')).toBe(
      '这个文件是带 BOM 的 UTF-8。落盘会把 BOM 去掉、转成规范格式；不放心就另存副本、原件不动。',
    );
  });

  it('行高三档：档位名与 tooltip', () => {
    expect(i18n.t('table:rowHeight.label')).toBe('行高');
    expect(i18n.t('table:rowHeight.custom')).toBe('自定义');
    expect(i18n.t('table:rowHeight.compact')).toBe('紧凑');
    expect(i18n.t('table:rowHeight.comfortable')).toBe('舒适');
    expect(i18n.t('table:rowHeight.spacious')).toBe('宽松');
    expect(i18n.t('table:rowHeight.compactTip')).toBe('单行行高');
    expect(i18n.t('table:rowHeight.comfortableTip')).toBe('约两行行高');
    expect(i18n.t('table:rowHeight.spaciousTip')).toBe('约四行行高');
  });
});
