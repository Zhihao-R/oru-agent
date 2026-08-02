import type { BackendProviderType } from '@shared/types';

/**
 * 三家 coding plan 的默认（大陆）Anthropic 兼容端点——单一事实源。
 * 主进程 `providerPresets.ts` 取此作预设 baseUrl；渲染层设置面板取此作 placeholder 提示，
 * 两层共用避免端点漂移。海外用户在 UI 覆盖 baseUrl 字段切到海外端点。
 *
 * 端点采集于 2026-07-21 厂商文档，**coding plan 端点会被厂商单方面变更**，改动时同步此处。
 */
export const CODING_PLAN_DEFAULT_ENDPOINT = {
  'glm-coding': 'https://open.bigmodel.cn/api/anthropic',
  'kimi-coding': 'https://api.moonshot.cn/anthropic',
  'minimax-coding': 'https://api.minimaxi.com/anthropic',
} as const satisfies Partial<Record<BackendProviderType, string>>;

export type CodingPlanType = keyof typeof CODING_PLAN_DEFAULT_ENDPOINT;

export function isCodingPlanType(type: BackendProviderType): type is CodingPlanType {
  return type in CODING_PLAN_DEFAULT_ENDPOINT;
}
