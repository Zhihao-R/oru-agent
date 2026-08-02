// @vitest-environment node

/** 第 2 期·debug 命名空间「中文文案快照基线」（开发者调试面板，用户拍板纳入第 2 期）。
 *  分组轴：source/event 是枚举字典（平级独立成组）；event=事件类型标题标签（DebugDrawer 标题 +
 *  EventRow 行名，部分共享），row=行内 cell 片段（状态/明细，常带数据插值）；group/timeline/
 *  roundList/drawer 是组件局部文案。details/* 在后续 batch。 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance, type i18n as I18n } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';
import { ROUND_SOURCES } from '@shared/debug/types';

let i18n: I18n;
beforeAll(async () => {
  i18n = createInstance();
  await i18n.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
});

const t = (key: string | string[], params?: Record<string, unknown>) => i18n.t(key, params);

describe('debug zh 文案快照', () => {
  it('round 来源标签（SourceChip，按 source 枚举 key 取词）', () => {
    expect(t('debug:source.main_chat')).toBe('对话');
    expect(t('debug:source.comment')).toBe('评论');
    expect(t('debug:source.taskboard')).toBe('任务');
    expect(t('debug:source.subagent')).toBe('子agent');
    expect(t('debug:source.background')).toBe('后台');
    expect(t('debug:source.dream')).toBe('复盘');
    expect(t('debug:source.capture')).toBe('抓取');
    expect(t('debug:source.compress')).toBe('压缩');
    expect(t('debug:source.auto_name')).toBe('命名');
    expect(t('debug:source.web_summary')).toBe('网页摘要');
    expect(t('debug:source.aside_comment')).toBe('评点');
    expect(t('debug:source.loop_reviewer')).toBe('Loop 审查');
    expect(t('debug:source.loop_compile')).toBe('Loop 编译');
    expect(t('debug:source.loop_work')).toBe('Loop 干活');
    expect(t('debug:source.platform')).toBe('远程平台');
    expect(t('debug:source.unknown')).toBe('未知');
  });

  it('每个 RoundSource 都有非回落译文（遍历 ROUND_SOURCES 全集，新增 source 漏配即红）', () => {
    // 配合 types.ts 的 ROUND_SOURCES（编译期全集）：加 source 漏列 → TS 红；漏配译文 → 此处红
    for (const s of ROUND_SOURCES) {
      expect(t(`debug:source.${s}`), `source.${s} 缺译文`).not.toBe(t('debug:source.unknown'));
    }
  });

  it('未知 source 回落 unknown（数组 key 回落链）', () => {
    expect(t(['debug:source.not_a_source', 'debug:source.unknown'])).toBe('未知');
  });

  it('RoundList 空/无输入/状态文案', () => {
    expect(t('debug:roundList.empty')).toBe('还没有调试日志。在设置里开启「调试日志」后跑一轮对话再来。');
    expect(t('debug:roundList.noUserText')).toBe('（无用户输入记录）');
    expect(t('debug:roundList.running')).toBe('进行中');
    expect(t('debug:roundList.interrupted')).toBe('已中断');
    expect(t('common:loading')).toBe('加载中…'); // RoundList 加载态复用 common
  });

  it('事件类型标题标签（DebugDrawer 标题；userInput/llmCallN/finalAnswer 等与 EventRow 行名共享；含 #index 插值）', () => {
    expect(t('debug:event.userInput')).toBe('用户输入');
    expect(t('debug:event.promptBuilt')).toBe('prompt 组装');
    expect(t('debug:event.inferenceView')).toBe('真实入参');
    expect(t('debug:event.llmCallN', { n: 3 })).toBe('LLM 调用 #3');
    expect(t('debug:event.llmCallUnfinished')).toBe('LLM 调用（未完成）');
    expect(t('debug:event.parallelGroup')).toBe('并发组');
    expect(t('debug:event.parallelGroupDone')).toBe('并发组（已完成）');
    expect(t('debug:event.toolCall')).toBe('工具调用');
    expect(t('debug:event.toolCallUnfinished')).toBe('工具调用（未完成）');
    expect(t('debug:event.finalAnswer')).toBe('最终回答');
    expect(t('debug:event.roundDone')).toBe('一轮完成');
    expect(t('debug:event.error')).toBe('错误');
  });

  it('EventRow 行内状态/明细（含插值；数据如 reason/message/id 透传）', () => {
    expect(t('debug:row.unfinished')).toBe('未完成');
    expect(t('debug:row.done')).toBe('完成');
    expect(t('debug:row.failed')).toBe('出错');
    expect(t('debug:row.truncated', { reason: 'length' })).toBe('截断:length');
    expect(t('debug:row.thinking', { n: '1.2k' })).toBe('思考 1.2k');
    expect(t('debug:row.firstToken', { dur: '0.3s' })).toBe('首 token 0.3s');
    expect(t('debug:row.errorPrefix', { message: 'boom' })).toBe('错误：boom');
    expect(t('debug:row.toolFallback', { id: 'abc12345' })).toBe('工具 abc12345');
    expect(t('debug:row.infNotRun')).toBe('未跑（resume）');
    expect(t('debug:row.infNotEnabled')).toBe('未启用');
    expect(t('debug:row.infNoCut')).toBe('无裁剪');
    expect(t('debug:row.infCut', { count: 5 })).toBe('裁 5 条');
  });

  it('详情面板 field 标签（details/* C1：ToolCall/Error/FinalAnswer/Generic/RoundStart/CopyableBlock）', () => {
    expect(t('debug:detail.copy')).toBe('复制');
    expect(t('debug:detail.copied')).toBe('已复制');
    expect(t('debug:detail.duration')).toBe('耗时');
    expect(t('debug:detail.status')).toBe('状态');
    expect(t('debug:detail.source')).toBe('来源');
    expect(t('debug:detail.phase')).toBe('阶段');
    expect(t('debug:detail.errorInfo')).toBe('错误信息');
    expect(t('debug:detail.stack')).toBe('堆栈');
    expect(t('debug:detail.totalInput')).toBe('总输入 token');
    expect(t('debug:detail.userAborted')).toBe('用户中止');
    expect(t('debug:detail.noTextOutput')).toBe('（无文本输出）');
    expect(t('debug:detail.fullPayload')).toBe('完整 payload');
    expect(t('debug:detail.userQuestion')).toBe('用户提问');
    expect(t('debug:detail.attachments', { count: 2 })).toBe('附件（2）');
    expect(t('debug:detail.toolCallId')).toBe('工具调用 id');
    expect(t('debug:detail.inputParams')).toBe('输入参数');
    expect(t('debug:detail.structuredMeta')).toBe('结构化元数据');
    expect(t('debug:detail.toolUnfinished')).toBe('⚠ 这次工具调用没有结束记录（可能卡死或进程异常退出）。');
    expect(t('debug:row.failed')).toBe('出错'); // ToolCallDetail 出错状态复用 row.failed
  });

  it('详情面板说明文字（details/* C2：InferenceView/LlmCall/PromptBuilt 含插值与长说明）', () => {
    expect(t('debug:detail.infDisabled')).toBe('裁剪未启用');
    expect(t('debug:detail.infEnabledNoCut')).toBe('已启用 · 本轮无裁剪');
    expect(t('debug:detail.infCutDetail', { cut: 3, sys: 1, persisted: 1, writeback: 1, chars: '2,000' })).toBe(
      '已启用 · 裁 3 条（system 1 / 落盘 1 / 写回 1） · 省 2,000 字符',
    );
    expect(t('debug:detail.realInput')).toBe('真实入参（wireHistory）');
    expect(t('debug:detail.degradeResume')).toBe(
      'claudeCode resume 路径——adapter 未跑，真实入参由 SDK 原生续 session 决定，调试视图不可见。',
    );
    expect(t('debug:detail.degradeLegacy')).toBe('该事件来自旧版 Oru，wire view 不可用。');
    expect(t('debug:detail.callIndex')).toBe('调用编号');
    expect(t('debug:detail.firstTokenLatency')).toBe('首 token 延迟');
    expect(t('debug:detail.cacheHit')).toBe('缓存命中');
    expect(t('debug:detail.outputText')).toBe('输出文本');
    expect(t('debug:detail.stableSystemChars')).toBe('稳定层字符数');
    expect(t('debug:detail.notShownHere')).toBe('不在这里展示什么：');
    expect(t('debug:detail.notShownSystemPrompt')).toBe('完整的 system prompt → 看「prompt 组装」事件');
    expect(t('debug:detail.notShownWireHistory')).toBe('模型真实入参（wireHistory）→ 看「真实入参」事件');
    expect(t('debug:detail.notShownTotals')).toBe('整轮总耗时、最终模型 → 看末尾的「最终回答」事件');
    // 注：promptNote 引用「推理视图」，但事件实际名为「真实入参」(event.inferenceView)——预存悬空指引，
    // 第 2 期逐字保留原文，内容修正属独立的改文案步骤（见汇报）
    expect(t('debug:detail.promptNote')).toBe('真实入参（adapter 之后的 wireHistory）见同一轮的「推理视图」事件。');
    expect(t('debug:detail.tokenUnavailable')).toBe(
      '当前 backend / provider 不暴露单次 LLM 的 token usage（如 Claude Code SDK、少数不支持 include_usage 的 OpenAI 兼容 provider），因此本次 input/output/缓存命中 token 不可见。',
    );
    expect(t('debug:detail.systemContextChars')).toBe('systemContext 字符数');
    expect(t('debug:detail.systemContextFull')).toBe('systemContext 全文');
  });

  it('并发组 / 时间线列头 / 抽屉（含 Trans 加粗 count 的原始标记）', () => {
    expect(t('debug:group.label', { count: 3 })).toBe('并发组（<b>3</b> 个工具）');
    expect(t('debug:group.total', { dur: '0.12s' })).toBe('共 0.12s');
    expect(t('debug:group.running')).toBe('运行中…');
    expect(t('debug:group.fromLlmCall', { n: 2 })).toBe('来自 LLM 调用 #2');
    expect(t('debug:timeline.colEvent')).toBe('事件');
    expect(t('debug:timeline.colDuration')).toBe('耗时');
    expect(t('debug:timeline.colToken')).toBe('token / 备注');
    expect(t('debug:timeline.colModelStatus')).toBe('model / 状态');
    expect(t('debug:timeline.empty')).toBe('这一轮还没有任何事件落盘');
    expect(t('debug:drawer.resize')).toBe('拖拽调整宽度');
  });
});
