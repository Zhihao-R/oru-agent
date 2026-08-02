// @vitest-environment node

/** app 命名空间（顶栏 TopBar / 左栏框架 SidebarLeft+Tabs / AgentChip）中文文案快照基线。
 *  AgentChip 层已做称呼收敛（个体名 {{name}} / 无名回落 Oru，不再出现「分身」）；
 *  nav.memory 已收敛为「{{name}} 手账」（手账集群）；其余「分身」/「Twin」在后续收敛批次另改。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('app zh 文案快照', () => {
  it('顶栏导航（"手账" 接个体名、动态 ws 键三态）', () => {
    expect(t('app:nav.journal')).toBe('手账'); // 首屏并入对话空态：顶栏「主页」→「手账」
    expect(t('app:nav.memory', { name: '阿果' })).toBe('阿果 手账'); // 称呼收敛：手账接个体名
    expect(t('app:nav.debugOff')).toBe('调试（已关）');
    expect(t('app:nav.promptbench')).toBe('Prompt 工作台');
    expect(t('app:ws.open')).toBe('已连接');
    expect(t('app:ws.connecting')).toBe('连接中');
    expect(t('app:ws.closed')).toBe('未连接');
  });

  it('主题/认证/设置（主题 tooltip 插值）', () => {
    expect(t('app:theme.dark')).toBe('暗色');
    expect(t('app:theme.system')).toBe('跟随系统');
    expect(t('app:themeTooltip', { label: '暗色' })).toBe('主题：暗色（点击切换）');
    expect(t('app:auth.notReady')).toBe('未就绪');
    expect(t('app:auth.checking')).toBe('正在检测模型后端…'); // settingsStore defaultAuth.hint

    expect(t('app:settings')).toBe('设置');
  });

  it('左栏 tab/空态 + AgentChip（称呼收敛：个体名{{name}}、无名回落 Oru、计数插值）', () => {
    expect(t('app:tab.chat')).toBe('对话');
    expect(t('app:tab.project')).toBe('文件');
    expect(t('app:noProjectSelected')).toBe('未选择项目');
    expect(t('app:newProject')).toBe('新建项目');
    expect(t('app:chip.todoTooltip', { count: 3 })).toBe('3 件事需要你处理');
    // 称呼收敛：working/identity 接个体名（{{name}}），fallback 物种名 Oru；不再出现「分身」
    expect(t('app:chip.working', { name: '阿果' })).toBe('阿果 还在跑活');
    expect(t('app:chip.identity', { name: '阿果', home: '/Users/x/Oru' })).toBe('阿果（家：/Users/x/Oru）');
    expect(t('app:chip.working', { name: 'Oru' })).toBe('Oru 还在跑活'); // 无名回落由 resolveOruName 传入 Oru
    expect(t('app:chip.fallback')).toBe('Oru');
  });

  it('应用外壳（App/ProjectIndicator/workspace）', () => {
    expect(t('app:projectListEmpty')).toBe('还没有项目。点下方"新建项目"添加。');
    expect(t('app:collapseSidebar')).toBe('收起左栏');
    expect(t('app:expandSidebar')).toBe('展开左栏');
    expect(t('app:expandSidebarHover')).toBe('悬停展开左栏');
    expect(t('app:expandAnnot')).toBe('展开批注栏');
    expect(t('app:annotLabel')).toBe('批注');
    expect(t('app:loading')).toBe('载入中…');
    expect(t('app:closeTab', { title: 'report.md' })).toBe('关闭 report.md');
  });
});
