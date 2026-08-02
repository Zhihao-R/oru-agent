// @vitest-environment node

/**
 * 第 2 期·settings 批次的「中文文案快照基线」（PreferencesSection 子单元）。
 * 期望值逐字钉死多行插值串（dreamOutcome.ok / clearMainConfirm）。
 * 称呼收敛已落地：原「分身」/「Twin」改接个体名 {{name}}（无名回落 Oru），断言传 name 验插值。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);
const P = 'settings:general'; // 原「偏好」页拆分后：外观/界面/开发者归「通用」

describe('settings 页面 zh 文案快照（整顿后七页 IA）', () => {
  it('明暗模式三档（动态键 mode.${m}）', () => {
    expect(t(`${P}.appearance.mode.light`)).toBe('日');
    expect(t(`${P}.appearance.mode.dark`)).toBe('夜');
    expect(t(`${P}.appearance.mode.system`)).toBe('系统');
  });

  it('配色主题名（赤陶→竹青，只改 themeName、存储 id terracotta 不动）', () => {
    expect(t(`${P}.appearance.themeName.terracotta`)).toBe('竹青');
    expect(t(`${P}.appearance.themeName.klein`)).toBe('克莱因');
    expect(t(`${P}.appearance.themeName.ember`)).toBe('落霞');
    expect(t(`${P}.appearance.themeName.mono`)).toBe('水墨');
    expect(t(`${P}.appearance.themeName.iris`)).toBe('鸢尾');
    expect(t(`${P}.appearance.themeName.peacock`)).toBe('孔雀蓝');
    expect(t(`${P}.appearance.themeName.snowline`)).toBe('雪线');
  });

  it('语言选择器选项（endonym 先例：中文/English 不翻）', () => {
    expect(t(`${P}.interface.langSystem`)).toBe('跟随系统');
    expect(t(`${P}.interface.langZh`)).toBe('中文');
    expect(t(`${P}.interface.langEn`)).toBe('English');
    expect(t(`${P}.interface.languageDesc`)).toBe(
      '界面显示语言；「跟随系统」按操作系统语言自动选择（非中文一律英文）',
    );
  });

  it('称呼收敛：权限页加载态/用途名/能力提示接个体名', () => {
    expect(t('settings:permissions.loading', { name: '阿果' })).toBe('阿果 加载中…');
    expect(t('settings:backend.usage.twinMain', { name: '阿果' })).toBe('阿果 主对话');
    expect(t('settings:backend.usage.twinBackground', { name: '阿果' })).toBe('阿果 背景查询');
    expect(t('settings:extensions.pluginEmptyHint', { name: '阿果' })).toBe('阿果 找到匹配 plugin 时会主动提议安装。');
  });

  it('多行确认语（data.clearMainConfirm，称呼收敛：两处分身→个体名）', () => {
    expect(t('settings:data.clearMainConfirm', { name: '阿果' })).toBe(
      '清空主对话？\n\n旧的对话历史会在阿果家目录下归档备份成 .jsonl.bak.<时间戳> 文件，\n但 SDK 端会开启全新 session（阿果从此不记得之前的对话）。',
    );
  });

  it('Dream 复盘多行插值结果（ok：无画像更新 / 有画像更新）', () => {
    expect(
      t(`${P}.dev.dreamOutcome.ok`, {
        facts: 2,
        fields: 1,
        episodes: 3,
        profile: t(`${P}.dev.dreamOutcome.none`),
      }),
    ).toBe('ok\n事实变更: 2\n项目变更: 1\n事件整合: 3\n画像/进度更新: （无）');
    expect(
      t(`${P}.dev.dreamOutcome.ok`, {
        facts: 0,
        fields: 0,
        episodes: 0,
        profile: '\n  - 用户偏好\n  - 项目进度',
      }),
    ).toBe('ok\n事实变更: 0\n项目变更: 0\n事件整合: 0\n画像/进度更新: \n  - 用户偏好\n  - 项目进度');
  });

  it('Dream 复盘其它分支', () => {
    expect(t(`${P}.dev.dreamOutcome.failed`, { error: '超时' })).toBe('失败\n超时');
    expect(t(`${P}.dev.dreamOutcome.skippedNoNew`)).toBe(
      '跳过：自上次复盘以来没有新对话——没调 LLM。\n继续聊几句再点。',
    );
  });

  it('权限策略表（2026-07-31 双向开关拍板，取代旧已授权清单）文案与插值', () => {
    expect(t('settings:permissions.actionTitle')).toBe('行动权限');
    expect(t('settings:policy.intro')).toBe(
      '每类行为要不要先问你。拨开 = 该类以后直接执行；拨回 = 恢复每次询问。默认值是推荐的平衡点，可以随时改。',
    );
    expect(t('settings:policy.behaviorZone')).toBe('行为');
    expect(t('settings:policy.modifierZone')).toBe('特殊情况（遇到时优先按这里的规则办）');
    // 非工作挡整表不渲染、只留一行说明（2026-08-01 PM 拍板，取代置灰表+长说明）
    expect(t('settings:policy.readonlyNote')).toBe(
      '当前是「只读」挡：能看不能改，写操作不自动执行。策略表只在「工作」挡可调。',
    );
    expect(t('settings:policy.dangerNote')).toBe(
      '当前是「危险」挡：除灾难级操作外一律直接执行。策略表只在「工作」挡可调。',
    );
    expect(t('settings:policy.askPersistFailed')).toBe('设置未能保存——重启后该行恢复默认');
    expect(t('settings:grants.revoke')).toBe('撤销');
    expect(t('settings:grants.grantedAt', { time: '3 分钟前' })).toBe('授权于 3 分钟前');
  });

  it('导航七页名与区块标题（含 count 插值）', () => {
    expect(t('settings:nav.title')).toBe('设置');
    expect(t('settings:nav.general')).toBe('通用');
    expect(t('settings:nav.permissions')).toBe('权限与行为');
    expect(t('settings:nav.capabilities')).toBe('能力');
    expect(t('settings:nav.platforms')).toBe('平台连接');
    expect(t('settings:nav.data')).toBe('数据');
    expect(t('settings:permissions.workTitle')).toBe('工作方式');
    expect(t('settings:data.archiveTitle')).toBe('对话归档');
    expect(t('settings:data.clearTitle')).toBe('清除');
    expect(t('settings:extensions.mcpSection', { count: 3 })).toBe('MCP 服务 · 3');
    expect(t('settings:extensions.pluginSection', { count: 0 })).toBe('Plugin · 0');
    expect(t('settings:status.enabled')).toBe('已启用');
  });

  it('Skill 空状态提示（称呼收敛：接个体名）', () => {
    expect(t('settings:skills.emptyHint', { name: '阿果' })).toBe(
      '阿果 在帮你跑完复杂任务后会主动提议「把这个流程存下来」。',
    );
  });

  it('extensions / MCP 详情 插值串逐字还原', () => {
    expect(t('settings:extensions.mcpStatus.toolCount', { base: '已就绪', count: 5 })).toBe(
      '已就绪 · 暴露 5 个工具',
    );
    expect(t('settings:extensions.pluginHasUpdate', { commit: 'a1b2c3d' })).toBe('有新版本 → a1b2c3d');
    expect(t('settings:mcpDetail.statusToolCount', { base: '已就绪', count: 3 })).toBe('已就绪 · 3 工具');
    expect(t('settings:mcpDetail.exposedTools', { count: 7 })).toBe('暴露的工具（7）');
    expect(t('settings:mcpDetail.testOk')).toBe('✓ 已连通');
    expect(t('settings:mcpDetail.testOkTools', { count: 2 })).toBe('✓ 已连通，2 工具');
    expect(t('settings:mcpDetail.testFailed', { message: '连接超时' })).toBe('✗ 连接超时');
    expect(t('settings:mcpDetail.deleteConfirm', { label: 'chrome-devtools' })).toBe(
      '将停止并从列表中移除 "chrome-devtools"。',
    );
    expect(t('settings:mcpDetail.status.probe_failed')).toBe('已连接，未探活');
  });

  it('平台连接 状态枚举与权限插值', () => {
    expect(t('settings:platforms.state.held-by-other')).toBe('已被另一实例占用');
    expect(t('settings:platforms.scopeMissing', { count: 2, list: 'im:message, contact:user' })).toBe(
      '缺 2 项权限：im:message, contact:user',
    );
    expect(t('settings:platforms.scopeCheckError', { error: '网络错误' })).toBe('无法检查权限：网络错误');
    expect(t('settings:platforms.intro')).toContain('在飞书 / Discord 私聊你的 Oru');
  });

  it('Skill 详情 删除确认插值', () => {
    expect(t('settings:skillDetail.deleteConfirm', { name: 'my-skill' })).toBe(
      '将从磁盘删除 skill "my-skill"（含其文件夹）。',
    );
    expect(t('settings:skillDetail.readError', { error: 'ENOENT' })).toBe('读取出错：ENOENT');
  });

  it('跨 namespace 复用通用词（common close/loading/saving）', () => {
    expect(t('common:close')).toBe('关闭');
    expect(t('common:loading')).toBe('加载中…');
    expect(t('common:saving')).toBe('保存中…');
  });

  it('Skill 来源标签（原 skillLabels.SOURCE_LABEL 补抽）', () => {
    expect(t('settings:extensions.skillSource.builtin')).toBe('内置');
    expect(t('settings:extensions.skillSource.standalone')).toBe('独立装');
    expect(t('settings:extensions.skillSource.plugin')).toBe('Plugin 内');
  });

  it('长描述（审批挡位）与权限文案逐字还原（迁入「权限与行为」页）', () => {
    expect(t('settings:permissions.approvalReadonly')).toBe('只读 · 只看不动手');
    expect(t('settings:permissions.screenDenied')).toBe('未授权——授予后才能截你 ⌥ 点的那块屏');
    expect(t('settings:permissions.presenceDesc')).toBe(
      '开则在任意 App 里按住 ⌥ 点一下，Oru 就凑过来说一句；需在系统设置授予「输入监控」和「屏幕录制」',
    );
    expect(t('settings:permissions.keepAwake')).toBe('干活时阻止休眠');
    expect(t('settings:permissions.keepAwakeDesc')).toBe(
      '开则 Oru 正在跑回合或后台任务时，保持这台 Mac 不休眠、屏幕不熄；干完自动恢复。默认关。',
    );
  });
});

describe('settings/backend zh 文案快照（供应商/模型/功能分配）', () => {
  it('provider 类型与 usage 动态键（"Twin" 字样原样保留）', () => {
    expect(t('settings:backend.providerType.anthropic')).toBe('Anthropic 直连');
    expect(t('settings:backend.providerType.custom-openai')).toBe('自定义 OpenAI 兼容');
    // 三家 coding plan 走产品专名，中英文界面同值（不译）
    expect(t('settings:backend.providerType.glm-coding')).toBe('GLM Coding Plan');
    expect(t('settings:backend.providerType.kimi-coding')).toBe('Kimi For Coding');
    expect(t('settings:backend.providerType.minimax-coding')).toBe('MiniMax Coding Plan');
    expect(t('settings:backend.usage.twinMain', { name: 'Twin' })).toBe('Twin 主对话'); // 模板接 name（此处传 Twin 验插值）
    expect(t('settings:backend.usage.loopReviewer')).toBe('Loop 审查员（建议选轻量模型）');
    expect(t('settings:backend.usage.loopCompile')).toBe('Loop 拆解（把目标拆成验收标准）');
  });

  it('confirm/error 插值（删除供应商、视觉降级多行串）', () => {
    expect(t('settings:backend.removeProviderConfirm', { label: '我的 OR' })).toBe(
      '确定删除供应商 "我的 OR" 吗？\n关联的 model 和功能分配也会被清除。',
    );
    expect(t('settings:backend.addFailedWith', { error: '超时' })).toBe('添加失败：超时');
    expect(t('settings:backend.visionDowngradeConfirm', { label: 'GPT-4o-mini' })).toBe(
      '切到「GPT-4o-mini」后，这个模型看不到图。\n如果你之前发过图，新模型只看到文字占位，不会真正看到图像内容。\n\n仍然切换？',
    );
  });

  it('表单/校验文案逐字还原', () => {
    expect(t('settings:backend.providersEmpty')).toBe(
      '还没有供应商。先添加一个，再去「模型」列出可用 model，最后到「功能分配」分配各用途。',
    );
    expect(t('settings:backend.supportsReasoning')).toBe('支持思考模式（extended thinking / reasoning）');
    expect(t('settings:backend.ctxInvalid')).toBe('上下文窗口须 ≥ 1024');
    expect(t('settings:backend.defaultLocalClaude')).toBe('（默认 · 本机 Claude 登录）');
  });
});

describe('settings/webSearch zh 文案快照', () => {
  it('引擎名/提示/申请（动态键，Tavily/AnySearch 专名保留）', () => {
    expect(t('settings:webSearch.engineLabel.bocha')).toBe('博查');
    expect(t('settings:webSearch.engineHint.tavily')).toBe('境外，需代理');
    expect(t('settings:webSearch.engineKeyApply.bocha')).toBe('去博查官网申请');
    expect(t('settings:webSearch.engineLabel.anysearch')).toBe('AnySearch');
    expect(t('settings:webSearch.engineHint.anysearch')).toBe('境外可直连，技术/学术类强，稍慢');
    expect(t('settings:webSearch.engineKeyApply.anysearch')).toBe('去 AnySearch 官网申请');
  });

  it('未知引擎灰化行提示（反序列化容错条目）', () => {
    expect(t('settings:webSearch.unsupportedHint')).toBe('来自其他版本，不再支持');
  });

  it('状态徽标（含 ○/● 符号）与失败插值', () => {
    expect(t('settings:webSearch.badgeConnected')).toBe('● 已连通');
    expect(t('settings:webSearch.badgeNotTested')).toBe('○ 未测试');
    expect(t('settings:webSearch.statusFailedWith', { error: '401' })).toBe('失败：401');
    expect(t('settings:webSearch.longSummaryDesc', { name: '阿果' })).toBe('超 5000 字时先 AI 摘要再交给阿果（省 token、更快）');
  });
});
