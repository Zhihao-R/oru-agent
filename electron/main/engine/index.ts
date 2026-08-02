/**
 * 代码执行引擎 — 业务代码唯一入口
 *
 * 业务代码 import { engine } from '../engine'，
 * 永远不要直接 import @anthropic-ai/claude-agent-sdk。
 */
import type { CodeExecutionEngine } from './types';
import { claudeAgentSdkEngine } from './claudeAgentSdk';

export const engine: CodeExecutionEngine = claudeAgentSdkEngine;

// 「子进程退出类错误」的 message 特征——backend 判定 spawn 阶段死法（如条款闸误杀重试）用。
export { PROCESS_EXIT_ERROR_RE } from './claudeAgentSdk';

export type {
  CodeExecutionEngine,
  EngineEvent,
  EngineHookContext,
  EngineHookHandler,
  EngineHookResult,
  EngineMcpFactory,
  EngineMcpServer,
  EnginePermissionMode,
  EnginePresetSystemPrompt,
  EngineRunHandle,
  EngineRunInput,
} from './types';
