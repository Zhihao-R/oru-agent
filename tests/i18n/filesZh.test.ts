// @vitest-environment node

/** 第 2 期·files 命名空间（文件树 + 右键菜单）「中文文案快照基线」。纯抽取，验收"中文界面一字不变"。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('files zh 文案快照', () => {
  it('文件树头部与空/加载态（"加载中..." 三点 ≠ common:loading 的省略号）', () => {
    expect(t('files:heading')).toBe('文件');
    expect(t('files:noProject')).toBe('请在顶栏选择一个项目');
    expect(t('files:loading')).toBe('加载中...');
    expect(t('files:loading')).not.toBe(t('common:loading'));
    expect(t('files:loadFailed')).toBe('加载失败，点击右上刷新');
    expect(t('files:moreItems', { count: 8 })).toBe('… 还有 8 项未显示');
  });

  it('回收站确认（name/count 插值，目录补「含其中所有内容」）', () => {
    expect(t('files:trashConfirm', { name: 'a.md' })).toBe('将「a.md」移到回收站？');
    expect(t('files:trashDirConfirm', { name: 'src' })).toBe('将「src」移到回收站？（含其中所有内容）');
    expect(t('files:trashMultiConfirm', { count: 3 })).toBe('将 3 项移到回收站？');
    expect(t('files:adoptRootHtmlError')).toBe('项目根目录下的 html 不能直接加入演示稿，请将它放进子文件夹');
  });

  it('右键菜单项（10 项全覆盖）', () => {
    expect(t('files:menu.newMd')).toBe('新建 Markdown');
    expect(t('files:menu.newCsv')).toBe('新建表格');
    expect(t('files:menu.newFolder')).toBe('新建文件夹');
    expect(t('files:menu.adoptDeck')).toBe('加入演示稿');
    expect(t('files:menu.reference')).toBe('引用到对话');
    expect(t('files:menu.rename')).toBe('重命名');
    expect(t('files:menu.duplicate')).toBe('创建副本');
    expect(t('files:menu.copyPath')).toBe('复制路径');
    expect(t('files:menu.reveal')).toBe('在访达中显示');
    expect(t('files:menu.trash')).toBe('移到回收站');
  });

  it('「+」按钮新建下拉（NewFileMenu 同右键同一动作：md/folder 复用 menu.*，仅 CSV 字面分歧单列）', () => {
    // md/folder 直接复用右键 menu.newMd/newFolder（同一源，上面已断言）；此处只钉分歧的 CSV
    expect(t('files:newMenuCsv')).toBe('新建 CSV 表格'); // 右键 menu.newCsv 是「新建表格」，见 glossary 同义异形
  });

  it('文件操作错误（fsStore：新建/改名/移动校验，FileTree 行内显示）', () => {
    expect(t('files:fsError.conflict')).toBe('目标已有同名文件');
    expect(t('files:fsError.invalid')).toBe('该位置不能移动到（目标在自身目录内）');
    expect(t('files:fsError.notFound')).toBe('原文件已不存在');
    expect(t('files:fsError.incomplete')).toBe('操作未完成：文档已改名但 .assets 可能没跟上，请检查该文件夹');
    expect(t('files:fsError.failed')).toBe('操作失败');
    expect(t('files:fsError.illegalChars')).toBe('名称不能包含 / 或 :');
    expect(t('files:fsError.emptyOrIllegal')).toBe('名称不能为空或含 / :');
    expect(t('files:fsError.createFailed')).toBe('创建失败');
    expect(t('files:fsError.exists')).toBe('已存在');
    expect(t('files:fsError.illegalName')).toBe('名称不合法');
  });

  it('按钮 tooltip / 空文件夹 / 失败提示', () => {
    expect(t('files:newTitle')).toBe('新建');
    expect(t('files:refreshTitle')).toBe('刷新');
    expect(t('files:emptyFolder')).toBe('空文件夹');
    expect(t('files:adoptFailed')).toBe('加入演示稿失败，请稍后重试');
  });
});
