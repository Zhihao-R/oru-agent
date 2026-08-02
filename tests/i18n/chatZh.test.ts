// @vitest-environment node

/**
 * 第 2 期·chat 命名空间「中文文案快照基线」。期望值逐字抄自抽取前的组件源码。
 * 纪律：本期纯抽取，"分身"字样原样保留——称呼收敛属后续独立步骤。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';
import { toolActivityText } from '@shared/agent/toolActivity';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string) => i18n.t(key);

describe('chat zh 文案快照', () => {
  it('发送前置守卫错误（chatStore set error，ChatArea 显示；agent/conversation 术语保留）', () => {
    expect(t('chat:noAgent')).toBe('没有可用的 agent');
    expect(t('chat:noConversation')).toBe('没有可用的 conversation');
  });

  it('输入框文案（称呼收敛：placeholder 接个体名）', () => {
    expect(i18n.t('chat:input.placeholder', { name: '阿果' })).toBe('跟阿果说点什么…');
    expect(t('chat:input.visionUnsupported')).toBe('当前模型不支持视觉，无法发送图片');
    expect(t('chat:input.loopOff')).toBe('Loop 模式 —— 对照标准把活干到达标');
    // attachBusy 已删（G02 收尾：忙时附件入口不再禁用，2026-07-13）
    expect(t('chat:input.send')).toBe('发送');
    expect(t('chat:input.removeRef')).toBe('移除引用');
  });

  it('对话区文案逐字还原（草稿问候 / 后端未就绪插值 / 视觉提示）', () => {
    expect(t('chat:draft.hello')).toBe('你好');
    expect(t('chat:draft.prompt')).toBe('今天想做点什么？');
    expect(t('chat:newConvTitle')).toBe('新对话');
    expect(i18n.t('chat:backendNotReady', { hint: '正在检测模型后端…' })).toBe('模型未就绪：正在检测模型后端…');
    expect(t('chat:vision.unsupported')).toBe('当前模型不支持视觉。在 设置 › 模型 切到支持视觉的模型即可。');
  });

  it('消息卡文案（steering / 定时触发 / 工具折叠插值）', () => {
    expect(t('chat:message.steeringQueued')).toBe('将生效');
    expect(t('chat:message.withdraw')).toBe('撤回');
    expect(i18n.t('chat:message.scheduledTriggerLabel', { title: '每日简报' })).toBe('定时任务 · 每日简报');
    expect(i18n.t('chat:message.toolFold', { count: 3 })).toBe('3 个工具');
    expect(i18n.t('chat:message.subagentFold', { count: 5 })).toBe('5 个 subagent');
  });

  it('流式状态行（进行中/终态插值）', () => {
    expect(t('chat:status.aborted')).toBe('已中断');
    expect(t('chat:status.thinking')).toBe('正在思考…');
    expect(i18n.t('chat:status.callingTool', { tool: 'mcp__oru__bash' })).toBe('正在调用 mcp__oru__bash…');
    expect(i18n.t('chat:status.retrying', { attempt: 2, max: 5 })).toBe('🔁 上游错误，正在重试 (2/5)…');
    expect(i18n.t('chat:status.errored', { message: '连接被拒' })).toBe('⚠ 连接被拒');
  });

  it('带选项提问卡 UI chrome（AI 产出的题面/选项不在此）', () => {
    expect(t('chat:askChoice.multiHint')).toBe('（可多选）');
    expect(t('chat:askChoice.otherPlaceholder')).toBe('都不是，我自己说…');
    expect(t('chat:askChoice.next')).toBe('下一问 →');
    expect(i18n.t('chat:askChoice.saidPrefix', { text: '再想想' })).toBe('（我说）再想想');
    expect(t('chat:askChoice.skipped')).toBe('跳过');
    expect(t('chat:askChoice.giveUp')).toBe('放弃这题');
    expect(t('chat:askChoice.giveUpConfirm')).toBe('放弃这道题？中断后对话可继续，刚才这场回复会停在半截。');
  });

  it('记忆卡（称呼收敛：scope 接个体名、撤销确认插值）', () => {
    expect(i18n.t('chat:memoryCard.scopePersona', { name: '阿果' })).toBe('阿果 自我');
    expect(i18n.t('chat:memoryCard.scope.agent', { name: '阿果' })).toBe('阿果 关系');
    // qa01 记忆两区合并：新值 user-basic/user-trait/self；旧值兜底归并到新措辞
    expect(t('chat:memoryCard.type.user-basic')).toBe('基本情况');
    expect(t('chat:memoryCard.type.user-trait')).toBe('特质叙述');
    expect(t('chat:memoryCard.type.self')).toBe('自我');
    expect(t('chat:memoryCard.type.persona')).toBe('自我');
    expect(i18n.t('chat:memoryCard.undoConfirm', { preview: '用户偏好简洁' })).toBe(
      '撤销这条记忆？\n\n"用户偏好简洁"',
    );
  });

  it('Loop 常驻条 chrome（进度/轮数/达标插值；轮数不带分母——2026-07-28 拍板）', () => {
    expect(i18n.t('chat:loop.progress', { satisfied: 3, total: 5 })).toBe('3 / 5 项达标');
    expect(i18n.t('chat:loop.status.round', { round: 2 })).toBe('第 2 轮');
    expect(i18n.t('chat:loop.status.doneAllMet', { round: 3 })).toBe('循环完成 · 第 3 轮达标');
    expect(t('chat:loop.status.compiling')).toBe('拆解验收标准中');
    expect(t('chat:loop.status.clarify')).toBe('没开跑 · 有个问题等你补充');
  });

  it('Loop 用户介入（常驻条：只留加一项；停止/划掉已随 2026-07-28 拍板退役）', () => {
    expect(t('chat:loop.addItem')).toBe('加一项');
    expect(t('chat:loop.status.stoppedByUser')).toBe('已停止');
    expect(t('chat:loop.status.stoppedAtLimit')).toBe('已到轮数上限');
    expect(i18n.t('chat:loop.status.interrupted', { round: 3 })).toBe('被打断 · 停在第 3 轮');
    expect(i18n.t('chat:loop.interruptedHint', { round: 3 })).toBe(
      '上次这个 Loop 被打断了。想接着做，就再发一条带 Loop 标记的「继续」——我会带着上面这些进度重新拆标准。',
    );
  });

  it('subagent / skillModule chip（插值，name 是数据）', () => {
    expect(t('chat:subagent.thinking')).toBe('思考中');
    expect(t('chat:subagent.noInnerSteps')).toBe('（暂无内部步骤）');
    expect(i18n.t('chat:skillModule.skillCalled', { name: 'deck-design' })).toBe('用了 deck-design skill');
    expect(i18n.t('chat:skillModule.pluginInstalled', { name: 'oru-x' })).toBe('已安装 plugin oru-x');
    expect(i18n.t('chat:skillModule.opFailed', { error: '网络超时' })).toBe('操作失败：网络超时');
  });

  it('subagent 活动卡状态 / 上下文压缩卡（称呼收敛：roleAssistant 接个体名）', () => {
    expect(t('chat:subagentCard.status.awaiting')).toBe('等你确认');
    expect(t('chat:compressed.summary')).toBe('摘要');
    expect(i18n.t('chat:compressed.originalCount', { count: 8 })).toBe('被压缩的原文（8 条）');
    expect(i18n.t('chat:compressed.roleAssistant', { name: '阿果' })).toBe('阿果');
    expect(i18n.t('chat:compressed.rolePrefix', { role: '用户' })).toBe('用户：');
  });

  it('工具调用卡 / 指代卡 / 回到最新（含 name 等数据插值）', () => {
    expect(t('chat:scrollToLatest')).toBe('回到最新消息');
    expect(t('chat:asideRef.zoom')).toBe('点击放大');
    expect(i18n.t('chat:toolCall.aria', { name: 'mcp__oru__bash' })).toBe(
      '工具调用 mcp__oru__bash，点击查看详情',
    );
    expect(i18n.t('chat:toolCall.candidates', { count: 12 })).toBe('候选 · 看了 12 张');
    expect(i18n.t('chat:toolCall.fromHost', { host: 'unsplash.com' })).toBe(' · 来源 unsplash.com');
    expect(t('chat:toolCall.openInOru')).toBe('在 Oru 中打开');
    expect(i18n.t('chat:toolCall.bgRunning', { elapsed: '12:34' })).toBe('运行中 12:34');
  });

  it('本轮文件变更条 / 定时任务确认卡（2026-07-20 对话文件组件；2026-07-28 决策二改名扩容）', () => {
    expect(t('chat:fileChanges.label')).toBe('本轮文件变更');
    expect(i18n.t('chat:fileChanges.count', { count: 12 })).toBe('12 个文件');
    expect(t('chat:fileChanges.expand')).toBe('展开');
    expect(t('chat:fileChanges.collapse')).toBe('收起');
    expect(t('chat:fileChanges.op.create')).toBe('新建');
    expect(t('chat:fileChanges.op.modify')).toBe('修改');
    expect(t('chat:fileChanges.op.delete')).toBe('删除');
    expect(t('chat:fileChanges.op.move')).toBe('移动');
    expect(t('chat:fileChanges.op.rename')).toBe('改名');
    expect(i18n.t('chat:fileChanges.otherProject', { name: '知识库' })).toBe(
      '属于项目「知识库」，切到该项目后可打开',
    );
    expect(i18n.t('chat:scheduledCard.nextRun', { when: '明天 09:00' })).toBe('下次运行 明天 09:00');
    expect(t('chat:scheduledCard.manage')).toBe('管理 →');
  });

  it('subagent 活动文案（toolActivityText 经 t 取词；归一 mcp__ 前缀；未知工具兜底）', () => {
    const tt = (k: string, p?: Record<string, unknown>) => i18n.t(k, p);
    expect(toolActivityText('Edit', 'a.ts', tt)).toBe('改 a.ts');
    expect(toolActivityText('mcp__oru__Grep', 'foo', tt)).toBe('搜 foo');
    expect(toolActivityText('Bash', undefined, tt)).toBe('正在跑…');
    expect(toolActivityText('UnknownTool', 'x', tt)).toBe('正在处理…');
  });

  it('来源段收起条（SourcesFootnote：上网回答的来源默认收起）', () => {
    expect(i18n.t('chat:sources.toggle', { count: 6 })).toBe('来源 · 6');
  });

  it('待处理项条（S08 · G14：故障 / 中断交还的机器触发与渠道消息）', () => {
    expect(t('chat:pendingHandback.heading')).toBe('以下几项在中断时未处理，交你发落');
    expect(t('chat:pendingHandback.readmit')).toBe('放行');
    expect(t('chat:pendingHandback.dismiss')).toBe('清掉');
    expect(t('chat:pendingHandback.scheduled')).toBe('定时任务');
    expect(t('chat:pendingHandback.taskCompleted')).toBe('后台任务');
    expect(t('chat:pendingHandback.channel')).toBe('渠道消息');
  });

  it('斜杠命令面板与反馈（slash.*：命令清单 / 模型清单 / 四态回执）', () => {
    expect(t('chat:slash.helpNew')).toBe('开新对话（当前这段保留在列表里）');
    expect(t('chat:slash.helpStop')).toBe('打断正在跑的活');
    expect(t('chat:slash.helpMode')).toBe('切审批挡位：/mode readonly | work | danger');
    expect(t('chat:slash.helpModel')).toBe('看模型清单；/model 编号 切换（全局，下一轮生效）');
    expect(t('chat:slash.helpCompress')).toBe('立刻压缩当前对话上下文');
    expect(t('chat:slash.helpHelp')).toBe('看这份清单');
    expect(t('chat:slash.modeReadonly')).toBe('只读挡');
    expect(t('chat:slash.modeWork')).toBe('工作挡');
    expect(t('chat:slash.modeDanger')).toBe('危险挡');
    expect(t('chat:slash.modeUsage')).toBe('用法：/mode readonly（只读）、work（工作）、danger（危险）');
    expect(i18n.t('chat:slash.modeSwitched', { mode: '危险挡' })).toBe('已切到「危险挡」。');
    expect(t('chat:slash.modelTitle')).toBe('主对话模型——切换是全局的（所有主对话一起换），下一轮生效');
    expect(t('chat:slash.modelSwitchHint')).toBe('输入 /model 编号 切换（如 /model 2）');
    expect(t('chat:slash.currentMark')).toBe('当前');
    expect(i18n.t('chat:slash.modelSwitched', { label: 'GPT-5' })).toBe(
      '已切到「GPT-5」——全局主对话模型，下一轮生效（正在跑的这轮不受影响）。',
    );
    expect(t('chat:slash.modelUsage')).toBe('用法：/model 看清单，/model 编号 切换（如 /model 2）。');
    expect(t('chat:slash.modelStale')).toBe('这个编号已失效，重新 /model 看最新清单。');
    expect(t('chat:slash.modelEmpty')).toBe('还没注册模型——去设置里添加。');
    expect(t('chat:slash.compress.compressed')).toBe('已压缩：早期内容整理成了摘要，上下文已腾出。');
    expect(t('chat:slash.compress.fallback')).toBe('摘要模型没调通，改为直接丢弃了早期内容，上下文已腾出。');
    expect(t('chat:slash.compress.busy')).toBe('正在跑活，等这轮说完再压。');
    expect(t('chat:slash.compress.tooShort')).toBe('对话还太短，没什么可压的。');
    expect(t('chat:slash.compress.nothingNew')).toBe('没有新内容可压。');
    expect(t('chat:slash.compress.failed')).toBe('压缩失败，请稍后再试。');
    expect(t('chat:slash.failed')).toBe('命令执行失败，请稍后再试。');
    expect(t('chat:slash.helpStatus')).toBe('看当前状态（模型、挡位、忙闲与排队）');
    expect(t('chat:slash.statusIdle')).toBe('空闲');
    expect(i18n.t('chat:slash.statusBusy', { count: 2 })).toBe('正在跑活，2 条排队');
    expect(t('chat:slash.statusDefaultModel')).toBe('默认档');
    expect(
      i18n.t('chat:slash.statusLine', { agent: '小欧', mode: '工作挡', model: 'GPT-5', state: '空闲' }),
    ).toBe('小欧 · 工作挡 · GPT-5 · 空闲');
  });
});
