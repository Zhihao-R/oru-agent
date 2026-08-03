/**
 * Track B 中央思考三态判据单测。
 *
 * resolveThinkingDisable(usage, settings) 按「该用途思考开关 + 该用途实际落到模型的能力」定
 * disableReasoning 三态：
 *   - 模型不支持思考 → undefined（后端缺省：claude-code 即压掉、anthropic 直连不发 thinking 参数）
 *   - 开关开（on=true）→ false（强制开）
 *   - 开关关（on=false）→ true（强制关）
 * defaultModelThinking() 按拍板分档：干活/对话类开、简单/廉价判断类关。
 */
import { describe, expect, it } from 'vitest';
import { defaultModelThinking, type RegisteredModel, type Settings } from '@shared/types';
import { resolveThinkingDisable } from '../../electron/main/agent/backends/factory';

const USAGE_KEYS: (keyof Settings['modelThinking'])[] = [
  'twinMain',
  'twinBackground',
  'memoryDream',
  'subagentCoder',
  'conversationSummary',
  'conversationTitle',
  'twinSubagent',
  'asideComment',
  'loopReviewer',
  'memoryRecall',
  'scheduledRun',
  'loopCompile',
];

function baseSettings(): Settings {
  return {
    theme: 'system',
    colorScheme: 'terracotta',
    language: 'system',
    manualApiKey: null,
    providers: [],
    models: [],
    modelAssignments: {
      twinMain: null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: null,
      conversationSummary: null,
      conversationTitle: null,
      twinSubagent: null,
      asideComment: null,
      loopReviewer: null,
      memoryRecall: null,
      scheduledRun: null,
      loopCompile: null,
    },
    modelThinking: defaultModelThinking(),
    migratedFromManualApiKey: false,
  };
}

function reasoningModel(id: string, supportsReasoning: boolean): RegisteredModel {
  return {
    id,
    providerId: 'p1',
    modelId: `m-${id}`,
    label: id,
    contextWindow: 200_000,
    supportsVision: false,
    supportsReasoning,
  };
}

describe('defaultModelThinking 分档', () => {
  it('干活/对话类默认开、简单/廉价判断类默认关', () => {
    const d = defaultModelThinking();
    // 开
    expect(d.twinMain).toBe(true);
    expect(d.twinSubagent).toBe(true);
    expect(d.subagentCoder).toBe(true);
    expect(d.scheduledRun).toBe(true);
    expect(d.twinBackground).toBe(true);
    // 关
    expect(d.conversationTitle).toBe(false);
    expect(d.memoryRecall).toBe(false);
    expect(d.loopReviewer).toBe(false);
    expect(d.conversationSummary).toBe(false);
    expect(d.memoryDream).toBe(false);
    expect(d.loopCompile).toBe(false);
    expect(d.asideComment).toBe(false);
  });

  it('覆盖 LLM_USAGES 全量用途（无遗漏 key）', () => {
    const d = defaultModelThinking();
    for (const k of USAGE_KEYS) expect(k in d).toBe(true);
  });
});

describe('resolveThinkingDisable', () => {
  it('模型不支持思考 → undefined（不强迫开，也不发 thinking 参数）', () => {
    const s = baseSettings();
    s.models = [reasoningModel('glm', false)];
    s.modelAssignments.twinMain = 'glm';
    expect(resolveThinkingDisable('twinMain', s)).toBeUndefined();
  });

  it('未分配模型（回落本机/默认 Claude）→ 支持思考', () => {
    const s = baseSettings();
    s.modelAssignments.twinMain = null;
    // twinMain 默认开 → false
    expect(resolveThinkingDisable('twinMain', s)).toBe(false);
  });

  it('干活用途 twinMain 缺省 → 开（false）', () => {
    const s = baseSettings();
    s.models = [reasoningModel('opus', true)];
    s.modelAssignments.twinMain = 'opus';
    expect(resolveThinkingDisable('twinMain', s)).toBe(false);
  });

  it('廉价用途 conversationTitle / memoryRecall 缺省 → 关（true）', () => {
    const s = baseSettings();
    s.models = [reasoningModel('haiku', true)];
    s.modelAssignments.conversationTitle = 'haiku';
    s.modelAssignments.memoryRecall = 'haiku';
    expect(resolveThinkingDisable('conversationTitle', s)).toBe(true);
    expect(resolveThinkingDisable('memoryRecall', s)).toBe(true);
  });

  it('显式关（modelThinking 存 false）仍关', () => {
    const s = baseSettings();
    s.models = [reasoningModel('opus', true)];
    s.modelAssignments.twinMain = 'opus';
    s.modelThinking.twinMain = false;
    expect(resolveThinkingDisable('twinMain', s)).toBe(true);
  });

  it('显式开（modelThinking 存 true）仍开', () => {
    const s = baseSettings();
    s.models = [reasoningModel('opus', true)];
    s.modelAssignments.conversationTitle = 'opus';
    s.modelThinking.conversationTitle = true;
    expect(resolveThinkingDisable('conversationTitle', s)).toBe(false);
  });

  it('老用户无 modelThinking 字段（undefined key）→ 落回 defaultModelThinking()[usage]', () => {
    const s = baseSettings();
    s.models = [reasoningModel('opus', true)];
    s.modelAssignments.twinMain = 'opus';
    // 模拟老数据缺 key：删掉 twinMain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (s.modelThinking as any).twinMain;
    expect(resolveThinkingDisable('twinMain', s)).toBe(false); // 干活缺省开
  });

  it('twinSubagent 跟随 twinMain（effectiveUsage 映射）', () => {
    const s = baseSettings();
    s.models = [reasoningModel('opus', true)];
    s.modelAssignments.twinMain = 'opus';
    expect(resolveThinkingDisable('twinSubagent', s)).toBe(false);
  });

  it('asideComment 未分配回落 twinMain', () => {
    const s = baseSettings();
    s.models = [reasoningModel('opus', true)];
    s.modelAssignments.twinMain = 'opus';
    s.modelAssignments.asideComment = null;
    expect(resolveThinkingDisable('asideComment', s)).toBe(true); // asideComment 默认关
  });
});
