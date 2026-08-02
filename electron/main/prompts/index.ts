/**
 * 副作用导入全部 prompt 模块，触发各自的 definePrompt 登记；
 * 再 re-export 注册表 API。任何要枚举全部 prompt 的地方（面板、测试）import 本 barrel。
 */
import './dream';
import './identity';
import './capture';
import './episodeType';
import './memoryBPath';
import './twinPersona';
import './webSearch';
import './image';
import './mcpSelfManage';
import './outputLanguage';
import './chromeDevtools';
import './deckRouting';
import './cadence';
import './profileProjectCoder';
import './profileTester';
import './profileInspector';
import './deckReviewGuard';
import './taskboardStable';
import './tableScript';
import './agentGuardrails';
import './selfKnowledge';

export { definePrompt, listPrompts, getPrompt } from './registry';
export type { PromptEntry, PromptMeta, PromptCategory } from './registry';
