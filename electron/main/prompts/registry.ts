/**
 * Prompt 集中清单。
 *
 * definePrompt 在模块加载时登记元数据并原样返回 body——下游对该常量的字符串用法零改动。
 * 这是唯一的 prompt 入口：要被看见/编辑/调试的静态 prompt 一律经此登记，
 * 没有第二份手写索引，故不会漂移。
 */

import type { PromptCategory, PromptEntry, PromptMeta } from '@shared/types';
import { CATEGORY_LABELS } from '@shared/types';

// 类型与 CATEGORY_LABELS 真相在 shared/types.ts（让 WS 协议层无需反向依赖 electron/main，
// 且前后端共用单一真相）；这里 re-export 保持 prompts 模块对外 API 不变。
export type { PromptCategory, PromptEntry, PromptMeta };
export { CATEGORY_LABELS };

const registry = new Map<string, PromptEntry>();

export function definePrompt(meta: PromptMeta, body: string): string {
  if (registry.has(meta.id)) {
    throw new Error(`prompt id 重复：${meta.id}`);
  }
  registry.set(meta.id, { ...meta, body });
  return body;
}

export function listPrompts(): PromptEntry[] {
  return [...registry.values()].sort(
    (a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id),
  );
}

export function getPrompt(id: string): PromptEntry | undefined {
  return registry.get(id);
}

/** 仅供单测隔离用——清空登记 */
export function __resetForTest(): void {
  registry.clear();
}
