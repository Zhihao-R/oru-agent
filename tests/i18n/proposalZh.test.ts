// @vitest-environment node

/** 第 2 期·proposal 命名空间（7 张审批卡）「中文文案快照基线」。纯抽取，验收"中文界面一字不变"。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string, params?: Record<string, unknown>) => i18n.t(key, params);

describe('proposal zh 文案快照', () => {
  it('共享 footer 文案（多卡复用）', () => {
    expect(t('proposal:accept')).toBe('让他去做');
    expect(t('proposal:reject')).toBe('我自己来');
    expect(t('proposal:nevermind')).toBe('算了');
    expect(t('proposal:decline')).toBe('拒绝');
    expect(t('proposal:failedWith', { error: '超时' })).toBe('失败：超时');
    expect(t('proposal:dispatching')).toBe('派工中…');
  });

  it('bash 卡（灾难告警；「切到工作模式」弱链及其 workModeTip 已删——PM 2026-07-13）', () => {
    expect(t('proposal:bash.title')).toBe('Agent 行为审批');
    expect(t('proposal:bash.catastrophic')).toBe(
      '绝对灾难命令（删根 / 抹盘 / 格式化级）——即便危险模式也强制停下，批准前务必再三核对。',
    );
    expect(t('proposal:bash.willOverwrite', { targets: 'a.txt、b.txt' })).toBe('将覆盖已存在的 a.txt、b.txt');
    expect(t('proposal:bash.delivery', { targets: 'evil.com' })).toBe(
      '将向外部送出内容：evil.com——发出后收不回，批准前确认目标可信。',
    );
  });

  it('持久授权与远程卡文案（S24：grant/remote/record 三组；整类标签 2026-07-30 起改走 behaviors 行标题）', () => {
    expect(t('proposal:grant.deliveryTo', { target: 'ou_xxx' })).toBe('向 ou_xxx 外发');
    expect(t('proposal:remote.allow')).toBe('允许');
    expect(t('proposal:remote.always')).toBe('始终允许');
    expect(t('proposal:remote.reject')).toBe('拒绝');
    expect(t('proposal:remote.approved')).toBe('已批准');
    expect(t('proposal:remote.rejected')).toBe('已拒绝');
    expect(t('proposal:record.byYou')).toBe('本人');
    expect(t('proposal:record.byChannel', { platform: '飞书' })).toBe('来自 飞书');
    expect(t('proposal:record.grantPersistFailed')).toBe('始终允许未能保存，下次仍会询问');
    expect(t('proposal:record.platform.feishu')).toBe('飞书');
    expect(t('proposal:record.platform.discord')).toBe('Discord');
  });

  it('行为分类注册表文案（2026-07-30 决策 1/3：卡标题 + 设置页策略表 + 授权粒度标注）', () => {
    expect(t('proposal:behaviors.webAccess.title')).toBe('访问网站');
    expect(t('proposal:behaviors.overwrite.title')).toBe('覆盖既有内容');
    expect(t('proposal:behaviors.fileDelete.title')).toBe('删除内容');
    expect(t('proposal:behaviors.sendExternal.title')).toBe('发送内容到外部');
    expect(t('proposal:behaviors.mcp.title')).toBe('变更系统环境 · MCP');
    expect(t('proposal:behaviors.scheduledTask.title')).toBe('创建自动化任务');
    expect(t('proposal:behaviors.destructiveCommand.title')).toBe('破坏性命令');
    expect(t('proposal:behaviors.catastrophic.title')).toBe('灾难级命令');
    expect(t('proposal:behaviors.unknown.title')).toBe('看不透的命令');
    expect(t('proposal:behaviors.alwaysWhole', { name: '覆盖既有内容' })).toBe(
      '始终允许：覆盖既有内容（整类）',
    );
    expect(t('proposal:behaviors.alwaysTo', { target: '飞书:研发群' })).toBe(
      '始终允许：向 飞书:研发群 发送',
    );
    expect(t('proposal:behaviors.alwaysMultiple', { count: 2 })).toBe('始终允许：2 类后果');
    expect(t('proposal:behaviors.alwaysMultipleHint', { list: '破坏性命令、覆盖既有内容' })).toBe(
      '将一并始终允许：破坏性命令、覆盖既有内容',
    );
    expect(t('proposal:behaviors.sendTo', { target: '飞书:研发群' })).toBe('向 飞书:研发群 发送');
    expect(t('proposal:behaviors.alwaysAsk')).toBe('始终询问');
    expect(t('proposal:behaviors.askEveryTime')).toBe('每次询问');
    expect(t('proposal:behaviors.noAsk')).toBe('直接执行');
  });

  it('策略表修饰区口语化文案与 tip（2026-07-31 双向开关拍板）', () => {
    expect(t('proposal:behaviors.noStructureGuarantee.title')).toBe('经命令行删改文件');
    expect(t('proposal:behaviors.noStructureGuarantee.desc')).toBe(
      '命令行删改文件没有回收站、也不防撞名覆盖，所以一律按破坏性命令问。',
    );
    expect(t('proposal:behaviors.aiOwned.title')).toBe('覆盖 Oru 自己的产出');
    expect(t('proposal:behaviors.aiOwned.desc')).toBe(
      '整篇覆盖 Oru 生成、你还没改过的文件时，不问。',
    );
    expect(t('proposal:behaviors.unknown.desc')).toBe(
      '命令里套了命令（$(…)、eval 等），Oru 判不出它到底要做什么。',
    );
    expect(t('proposal:behaviors.catastrophic.desc')).toBe(
      'rm -rf /、抹盘、格式化——每次都问，不能授权跳过。',
    );
    expect(t('proposal:behaviors.sendExternal.desc')).toBe(
      '经命令把内容发给他人或外部服务。拨开 = 所有外发不再问（谨慎）；拨回 = 按收件人逐一确认。',
    );
    // tip（hover 技术解释）：五行都有
    for (const id of ['catastrophic', 'unknown', 'noStructureGuarantee', 'aiOwned', 'sendExternal']) {
      expect(t(`proposal:behaviors.${id}.tip`)).toBeTruthy();
    }
  });

  it('网页抓取卡（S04 投递档）', () => {
    expect(t('proposal:webFetch.pending')).toBe('网页抓取待确认');
    expect(t('proposal:webFetch.hint')).toBe(
      'Oru 想抓取一个自己找到的外部地址（不是你给的链接）。抓取请求会把地址和参数发往该站点，发出后收不回。',
    );
    expect(t('proposal:webFetch.confirm')).toBe('允许抓取');
    expect(t('proposal:webFetch.fetched')).toBe('已抓取——内容见聊天');
  });

  it('打开网页卡（S33 浏览器操控，与网页抓取同族投递档）', () => {
    expect(t('proposal:browserNavigate.pending')).toBe('打开网页待确认');
    expect(t('proposal:browserNavigate.hint')).toBe(
      'Oru 想用内置浏览器打开一个自己找到的外部地址（不是你给的链接），并在页面上操作。访问请求会把地址发往该站点，发出后收不回。',
    );
    expect(t('proposal:browserNavigate.confirm')).toBe('允许打开');
  });

  it('定时任务卡（action 动态键、分隔符拆分后逐字一致）', () => {
    expect(t('proposal:scheduledTask.action.create')).toBe('创建定时任务');
    expect(t('proposal:scheduledTask.action.pause')).toBe('暂停定时任务');
    expect(t('proposal:scheduledTask.pending')).toBe('待确认');
    expect(t('proposal:scheduledTask.stopAfter', { count: 3 })).toBe('重复 3 次后停');
    // 渲染端 `{pending} · {action}` 合成 "待确认 · 创建定时任务"
    expect(`${t('proposal:scheduledTask.pending')} · ${t('proposal:scheduledTask.action.create')}`).toBe(
      '待确认 · 创建定时任务',
    );
  });

  it('file 卡（4 个 mode 动态键 verb/approve 全覆盖 + 截断提示带换行）', () => {
    expect(t('proposal:file.createVerb')).toBe('新建文件');
    expect(t('proposal:file.createApprove')).toBe('写入');
    expect(t('proposal:file.overwriteVerb')).toBe('覆盖文件');
    expect(t('proposal:file.overwriteApprove')).toBe('覆盖');
    expect(t('proposal:file.editVerb')).toBe('编辑文件');
    expect(t('proposal:file.editApprove')).toBe('应用修改');
    expect(t('proposal:file.deleteVerb')).toBe('删除文件');
    expect(t('proposal:file.deleteApprove')).toBe('删除');
    expect(t('proposal:file.moveVerb')).toBe('移动文件');
    expect(t('proposal:file.moveApprove')).toBe('移动');
    expect(t('proposal:file.renameVerb')).toBe('重命名文件');
    expect(t('proposal:file.renameApprove')).toBe('重命名');
    expect(t('proposal:file.truncated', { count: 8000 })).toBe('\n…[预览截断，共 8000 字符]');
  });

  it('skill / mcp / code / deck 卡专属串', () => {
    expect(t('proposal:skill.mcpConflicts', { count: 2 })).toBe(
      '发现 2 个同名 MCP 冲突（第 2 期接入"覆盖 / 跳过 / 并存"选项）',
    );
    expect(t('proposal:skill.keyFilesChanged', { count: 5 })).toBe('5 个 key 文件变化');
    expect(t('proposal:mcp.deleteStatus', { status: 'idle', count: 3 })).toBe('当前 idle · 暴露 3 个工具');
    expect(t('proposal:mcp.installed')).toBe('✓ 已装好');
    expect(t('proposal:code.riskHigh')).toBe('高风险');
    expect(t('proposal:deck.startGenerate')).toBe('⇡ 开始生成');
    // 下沉到卡组的单卡专属键（原误置顶层）
    expect(t('proposal:scheduledTask.confirm')).toBe('确认');
    expect(t('proposal:skill.executed')).toBe('已执行');
  });
});
