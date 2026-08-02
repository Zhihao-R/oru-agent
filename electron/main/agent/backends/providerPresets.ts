/**
 * anthropic-native 协议各类型的端点与鉴权预设。
 *
 * openai-fc 侧的对应表在 `openaiCompatible.ts` 的 DEFAULT_BASE_URL + resolveOpenAICompatibleBaseURL，
 * 本表与之并存、两协议分立同构。factory / testConnection 先按 providerProtocol 二分，anthropic-native
 * 分支统一走本函数拿端点与 authMode。
 *
 * authMode 决定凭证怎么发：
 * - 'x-api-key' → SDK `apiKey` 选项（发 `x-api-key` 头，Anthropic 官方形态）
 * - 'bearer'    → SDK `authToken` 选项（发 `Authorization: Bearer`）
 *
 * 三家 coding plan 的 baseUrl / authMode 取自 2026-07-21 厂商事实表，**authMode 待 Task 0 真机
 * （需真实订阅 key）核实**——各厂商 Anthropic 兼容端点多用 ANTHROPIC_AUTH_TOKEN（Bearer），先按此默认，
 * 核实后就地改。baseUrl 预填大陆端点，海外用户在 UI 覆盖 baseUrl 字段。
 */
import type { BackendProviderType } from '@shared/types';
import { CODING_PLAN_DEFAULT_ENDPOINT } from '@shared/agent/codingPlanEndpoints';

export type AuthMode = 'x-api-key' | 'bearer';

// baseUrl 取自共享单一事实源 codingPlanEndpoints（与 UI placeholder 同源）；authMode 是主进程独有关注
// （鉴权模式，待 Task 0 真机核实）。
const ANTHROPIC_COMPATIBLE_PRESETS: Partial<
  Record<BackendProviderType, { baseUrl: string; authMode: AuthMode }>
> = {
  'glm-coding': { baseUrl: CODING_PLAN_DEFAULT_ENDPOINT['glm-coding'], authMode: 'bearer' },
  'kimi-coding': { baseUrl: CODING_PLAN_DEFAULT_ENDPOINT['kimi-coding'], authMode: 'bearer' },
  'minimax-coding': { baseUrl: CODING_PLAN_DEFAULT_ENDPOINT['minimax-coding'], authMode: 'bearer' },
};

/**
 * 解析 anthropic-native 类型的 baseUrl 与鉴权模式。
 * - 三家 coding plan：override 优先，否则用预设默认端点；authMode 取预设。
 * - anthropic 直连：无预设，baseUrl = override（不传则 undefined，SDK 用官方端点）；authMode 恒 'x-api-key'。
 * - 其余（将来漏填预设的 anthropic-native 新类型）：fail-closed 抛错，绝不静默用空端点
 *   （对位 resolveOpenAICompatibleBaseURL 对 custom-openai 的既有行为）。
 */
export function resolveAnthropicCompatiblePreset(
  type: BackendProviderType,
  baseUrlOverride?: string,
): { baseUrl?: string; authMode: AuthMode } {
  const override = baseUrlOverride?.trim();
  const normalizedOverride = override ? override.replace(/\/$/, '') : undefined;

  const preset = ANTHROPIC_COMPATIBLE_PRESETS[type];
  if (preset) {
    return { baseUrl: normalizedOverride ?? preset.baseUrl, authMode: preset.authMode };
  }

  if (type === 'anthropic') {
    // 官方直连：baseUrl 缺省交给 SDK 用官方端点；允许 override 自建代理。鉴权发 x-api-key。
    return { baseUrl: normalizedOverride, authMode: 'x-api-key' };
  }

  throw new Error(
    `anthropic-native 类型 ${type} 没有端点预设，必须在 providerPresets.ts 登记 baseUrl 与 authMode`,
  );
}
