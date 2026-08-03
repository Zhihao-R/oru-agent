/**
 * Agent backend 包对外入口
 *
 * 业务代码 import { getBackendFor } from './backends'，
 * 永远不要直接 import 任何 LLM provider SDK。
 *
 * 段 A 起 factory 取代了原 singleton。getBackendFor(usage) 按用途路由 + 实时实例化，
 * 工具通过 registerTool(tool, usages[]) 注册到 factory。
 */
export { ClaudeCodeBackend } from './claudeCode';
export {
  getBackendFor,
  resolveThinkingDisable,
  subagentCoderReady,
  registerTool,
  unregisterTool,
  __setBackendFactoryForTest,
  __clearToolRegistryForTest,
  __listRegisteredToolsForTest,
} from './factory';
export { runOneShotWithTimeout } from './runOneShotWithTimeout';
