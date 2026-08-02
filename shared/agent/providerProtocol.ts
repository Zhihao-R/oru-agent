/**
 * provider 类型 → 线上协议。factory / testConnection 据此二分分派构造哪个 backend、走哪条探活路径。
 *
 * - `anthropic-native`：走 AnthropicBackend（Anthropic Messages 协议）。anthropic 直连 + 三家
 *   coding plan 订阅（GLM/Kimi/MiniMax 的 Anthropic 兼容端点）都在此。
 * - `openai-fc`：走 OpenAICompatibleBackend（OpenAI function-calling 协议）。
 *
 * 映射用 `satisfies Record<BackendProviderType, ...>` 穷举——将来再加 provider 类型漏登记即编译红。
 * types.ts 只放类型不放运行时函数，故此函数按 toolName.ts 等既有惯例独立成文件。
 */
import type { BackendProviderType } from '@shared/types';

export type ProviderProtocol = 'anthropic-native' | 'openai-fc';

const PROTOCOL = {
  anthropic: 'anthropic-native',
  'glm-coding': 'anthropic-native',
  'kimi-coding': 'anthropic-native',
  'minimax-coding': 'anthropic-native',
  openrouter: 'openai-fc',
  openai: 'openai-fc',
  zhipu: 'openai-fc',
  kimi: 'openai-fc',
  'custom-openai': 'openai-fc',
} satisfies Record<BackendProviderType, ProviderProtocol>;

export function providerProtocol(type: BackendProviderType): ProviderProtocol {
  return PROTOCOL[type];
}
