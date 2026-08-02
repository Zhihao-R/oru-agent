/**
 * 各 BackendProvider 类型的推荐 model 列表（用户在 Settings 第二层"我的模型"展开 provider 时看到这些一键添加项）。
 *
 * 维护原则：
 * - 只放经过验证的旗舰款（工具调用稳定）
 * - 用户也可以手填任意 model id，不限于此表
 * - 未来更新模型时只动这一份
 * - **prompt cache**：除非官方明确不支持，新增模型默认 `supportsPromptCache: true`。
 *   - Anthropic 直连：行为闸门——true 时给 system 段拆 stable+dynamic 并打 cache_control
 *   - OpenRouter：行为闸门——true 时同样给 system 段打 block-level cache_control:ephemeral，
 *     OR 透传给支持显式 cache 的上游（Anthropic / Qwen 等）；不支持该字段的 upstream OR 会忽略
 *   - OpenAI / 智谱 / Kimi 直连：纯事实陈述——cache 由平台隐式自动触发，flag 不进入请求体
 *
 * 字段说明（2026-05-06 模型参数录入扩字段）：
 * - 推荐 chip 点一下要把所有字段一次配齐，所以这里每一项必须填全
 * - 自定义模型由用户在 ModelEditRow 里手填
 */
import type { BackendProviderType } from '@shared/types';

export type ModelRecommendation = {
  /** 直接喂给 API 的 model id */
  modelId: string;
  /** 用户可见的显示名 */
  label: string;
  /** 简短场景说明（UI 可显示） */
  hint?: string;
  /** 模型上下文窗口（token） */
  contextWindow?: number;
  /** 是否支持视觉（图片输入） */
  supportsVision?: boolean;
  /** 单次回复输出 token 上限；不填走 backend 默认 */
  maxOutputTokens?: number;
  /**
   * 是否支持 prompt cache。
   * - Anthropic 直连 / OpenRouter：行为闸门——true 时给 system 段打 cache_control:ephemeral
   * - OpenAI / 智谱 / Kimi 直连：纯事实陈述——cache 由平台隐式触发，flag 不进入请求体
   */
  supportsPromptCache?: boolean;
  /** 是否支持思考模式（extended thinking / reasoning） */
  supportsReasoning?: boolean;
};

// Claude 4.5 / 4.6 / 4.7 全系：vision、prompt cache、extended thinking 均支持
const ANTHROPIC: ModelRecommendation[] = [
  { modelId: 'claude-opus-4-7', label: 'Claude Opus 4.7', hint: '最强推理；最贵', contextWindow: 200_000, supportsVision: true, supportsPromptCache: true, supportsReasoning: true },
  { modelId: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: '默认推荐；性价比最高', contextWindow: 200_000, supportsVision: true, supportsPromptCache: true, supportsReasoning: true },
  { modelId: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: '最快最便宜；适合背景查询', contextWindow: 200_000, supportsVision: true, supportsPromptCache: true, supportsReasoning: true },
];

// supportsPromptCache 默认 false：cache_control 走 OR 透传给上游，但只有 Anthropic 系
// 上游真正按显式协议消费它；其他上游（OpenAI/Gemini/Qwen 等）是否静默忽略 vs 报错不定。
// 一键添加默认不开缓存最安全；用户用 anthropic/* via OR 时去 ModelEditRow 手动勾上。
const OPENROUTER: ModelRecommendation[] = [
  { modelId: 'anthropic/claude-sonnet-4.6', label: 'Sonnet 4.6（OpenRouter）', hint: 'Anthropic 走 OpenRouter', contextWindow: 200_000, supportsVision: true, supportsPromptCache: false, supportsReasoning: true },
  { modelId: 'anthropic/claude-haiku-4.5', label: 'Haiku 4.5（OpenRouter）', hint: '便宜快速', contextWindow: 200_000, supportsVision: true, supportsPromptCache: false, supportsReasoning: true },
  { modelId: 'openai/gpt-5', label: 'GPT-5', hint: 'OpenAI 旗舰', contextWindow: 400_000, supportsVision: true, supportsPromptCache: false, supportsReasoning: true },
  { modelId: 'openai/gpt-5-mini', label: 'GPT-5 mini', hint: 'OpenAI 性价比款', contextWindow: 400_000, supportsVision: true, supportsPromptCache: false, supportsReasoning: true },
  { modelId: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: 'Google 旗舰；超长上下文', contextWindow: 1_000_000, supportsVision: true, supportsPromptCache: false, supportsReasoning: true },
  { modelId: 'moonshotai/kimi-k2', label: 'Kimi K2', hint: '国产；中文好', contextWindow: 200_000, supportsVision: false, supportsPromptCache: false, supportsReasoning: false },
  { modelId: 'zai-org/glm-4.6', label: 'GLM 4.6', hint: '国产；性价比', contextWindow: 200_000, supportsVision: false, supportsPromptCache: false, supportsReasoning: false },
];

const OPENAI: ModelRecommendation[] = [
  { modelId: 'gpt-5', label: 'GPT-5', hint: '旗舰', contextWindow: 400_000, supportsVision: true, supportsPromptCache: true, supportsReasoning: true },
  { modelId: 'gpt-5-mini', label: 'GPT-5 mini', hint: '性价比款', contextWindow: 400_000, supportsVision: true, supportsPromptCache: true, supportsReasoning: true },
];

const ZHIPU: ModelRecommendation[] = [
  { modelId: 'glm-4.6', label: 'GLM 4.6', hint: '智谱旗舰', contextWindow: 200_000, supportsVision: false, supportsPromptCache: true, supportsReasoning: false },
  { modelId: 'glm-4-flash', label: 'GLM 4 Flash', hint: '快速廉价', contextWindow: 128_000, supportsVision: false, supportsPromptCache: true, supportsReasoning: false },
];

const KIMI: ModelRecommendation[] = [
  { modelId: 'kimi-k2', label: 'Kimi K2', hint: 'Moonshot 旗舰', contextWindow: 200_000, supportsVision: false, supportsPromptCache: false, supportsReasoning: false },
];

const CUSTOM_OPENAI: ModelRecommendation[] = [];

// 三家 coding plan 推荐——model id 取自 2026-07-21 厂商事实表，**待 Task 0 真机核实**（厂商会静默换搭载模型）。
// supportsPromptCache 一律 false：cache_control 在第三方端点「容忍」不等于「生效」（OR 实测教训），默认关。
// supportsVision 按厂商文档、拿不准填 false：historyAdapter 会自动降级为文字占位，错关比错开安全。
const GLM_CODING: ModelRecommendation[] = [
  { modelId: 'glm-4.7', label: 'GLM-4.7', hint: '智谱 Coding Plan 搭载款（待核）', contextWindow: 200_000, supportsVision: false, supportsPromptCache: false, supportsReasoning: true },
];
const KIMI_CODING: ModelRecommendation[] = [
  { modelId: 'kimi-for-coding', label: 'Kimi For Coding', hint: 'Moonshot Coding 专用（待核）', contextWindow: 200_000, supportsVision: false, supportsPromptCache: false, supportsReasoning: false },
];
const MINIMAX_CODING: ModelRecommendation[] = [
  { modelId: 'MiniMax-M2.5', label: 'MiniMax M2.5', hint: 'MiniMax Coding Plan 搭载款（待核）', contextWindow: 200_000, supportsVision: false, supportsPromptCache: false, supportsReasoning: false },
];

// 全量穷举映射：新增 provider 类型漏登记即编译红（取代原 switch + default:[] 的静默空推荐盲区）。
const RECOMMENDATIONS = {
  anthropic: ANTHROPIC,
  openrouter: OPENROUTER,
  openai: OPENAI,
  zhipu: ZHIPU,
  kimi: KIMI,
  'custom-openai': CUSTOM_OPENAI,
  'glm-coding': GLM_CODING,
  'kimi-coding': KIMI_CODING,
  'minimax-coding': MINIMAX_CODING,
} satisfies Record<BackendProviderType, ModelRecommendation[]>;

export function getRecommendations(providerType: BackendProviderType): ModelRecommendation[] {
  return RECOMMENDATIONS[providerType];
}
