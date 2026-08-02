/**
 * Deck 路由能力——路由文本从第一层（stableSystemContext）迁到第二层（capabilityPrompt），
 * deck 文案变动不再击穿子 agent 共享的第一断点缓存。本能力只迁 prompt 归属；
 * propose_deck_create 等工具仍走 registerStaticAgentTools 的注入路径，不在这里带。
 *
 * audience 必须显式含 twinSubagent：工具桶的 twinSubagent 透明继承（factory.injectTools
 * 硬约束）不适用于 capability——registry 是纯 audience 过滤、不继承，只写 twinMain 会让
 * 持有 propose_deck_create 的对话期 subagent 丢路由段。
 * 缘起与整批缓存分层修正见 docs/plans/2026-07-14-上下文组装精简与缓存分层修正.md。
 */
import type { Capability } from '../types';
import { DECK_ROUTING_HINT } from '../../../prompts/deckRouting';

export const deckCapability: Capability = {
  id: 'deck',
  audience: ['twinMain', 'twinSubagent'],
  buildPrompt: async () => DECK_ROUTING_HINT,
};
