/**
 * 能力包对外入口 —— registerBuiltinCapabilities() 启动期调，与 registerStaticAgentTools 平行。
 *
 * 它把每个内置能力登记进能力注册表（供 provision / factory 阶段一查），并把能力带的
 * AgentTool 注册进 factory 的 toolRegistry（usages=audience）——于是工具走 injectTools
 * 本来的同步注入循环，无需为能力另造一条注入路径。
 */
import { registerTool } from '../backends';
import { registerCapability } from './registry';
import type { Capability } from './types';
import { webSearchCapability } from './builtins/webSearch';
import { projectClaudeMdCapability } from './builtins/projectClaudeMd';
import { deckCapability } from './builtins/deck';
import { imageCapability } from './builtins/image';
import { deckReviewCapability } from './builtins/deckReview';
import { larkCapability } from './builtins/lark';
import { scheduledTasksCapability } from './builtins/scheduledTasks';
import { renderHtmlCapability } from './builtins/renderHtml';
import { memoryCurationCapability } from './builtins/memoryCuration';
import { browserControlCapability } from './builtins/browserControl';

const BUILTIN_CAPABILITIES: Capability[] = [
  webSearchCapability,
  projectClaudeMdCapability,
  // deck 在 image 之前：两段在 capabilityPrompt 里相邻——配图服务 deck 也服务 HTML/md，
  // 不合并成一段
  deckCapability,
  imageCapability,
  deckReviewCapability,
  larkCapability,
  scheduledTasksCapability,
  renderHtmlCapability,
  memoryCurationCapability,
  // 浏览器操控（S33）：追加在末尾——数组顺序即工具注册顺序，插中间击穿 prompt cache
  browserControlCapability,
];

export function registerBuiltinCapabilities(): void {
  for (const cap of BUILTIN_CAPABILITIES) {
    registerCapability(cap);
    for (const make of cap.makeTools ?? []) {
      registerTool(make(), cap.audience);
    }
  }
}

export { provisionAgent } from './provision';
export type { AgentProvision } from './provision';
export { getCapabilitiesForUsage } from './registry';
export type { Capability, CapabilityContext, AgentUsage } from './types';
