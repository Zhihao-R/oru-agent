/**
 * 能力注册表 —— 启动期由 registerBuiltinCapabilities() 填充，运行期只读。
 *
 * 是"哪个 agent 有哪些能力"的单一可查处（PRD 验收 §3：差异在一处可查）。
 */
import type { LlmUsage } from '@shared/types';
import type { Capability } from './types';

const registry: Capability[] = [];

export function registerCapability(cap: Capability): void {
  registry.push(cap);
}

/**
 * 取受众包含 `usage` 的全部能力。
 * usage 用 LlmUsage（factory 阶段一传进来的可能是 memoryDream 等非 agent 用途）——
 * audience 永不含这些值，自然返回空，无需调用方先收窄类型。
 */
export function getCapabilitiesForUsage(usage: LlmUsage): Capability[] {
  return registry.filter((c) => (c.audience as readonly LlmUsage[]).includes(usage));
}

/** 仅测试用：清空注册表 */
export function __clearCapabilityRegistryForTest(): void {
  registry.length = 0;
}

/** 仅测试用：列出已注册能力 */
export function __listCapabilitiesForTest(): Capability[] {
  return [...registry];
}
