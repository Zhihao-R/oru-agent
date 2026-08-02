/**
 * 记忆整理能力（S31·G47）——把"夜间 dream 复盘"这个后台场景纳入统一裁剪体系。
 *
 * 此前 dream.ts 手工接线：工具注册到 memoryDream 桶、DREAM 守则作为 systemContext 硬拼——工具与 prompt
 * 分处两地，对齐税同源（改一处忘另一处不报错）。迁成能力后一处声明（audience=memoryDream，带整理专属工具
 * ＋守则），dream.ts 经 provisionAgent 装配。共享的记忆读写工具（grep/read/query/write/edit_memory）仍是
 * 主对话/后台/dream 三方共用的基础设施、留在 factory 的多受众桶（含 memoryDream），不属本能力独有。
 */
import type { Capability } from '../types';
import { createDreamReadTools, createDreamWriteTools } from '../../../memory/dreamTools';
import { DREAM_SYSTEM_PROMPT } from '../../../prompts/dream';

// dream 专属工具由 dreamTools 以「成组工厂」暴露（createDreamRead/WriteTools 返回数组，且被 dreamTools 测试
// 复用），非 web-search 那种逐个工厂函数——故这里成组构造一次再包 thunk，而不是逐个 factory ref。
// registerBuiltinCapabilities 启动期只调 makeTools 一趟，构造时机与此前 registerStaticAgentTools 一致，
// thunk 返回同一实例无碍（单次消费、不复用）。
const DREAM_TOOLS = [...createDreamReadTools(), ...createDreamWriteTools()];

export const memoryCurationCapability: Capability = {
  id: 'memory-curation',
  audience: ['memoryDream'],
  makeTools: DREAM_TOOLS.map((tool) => () => tool),
  // 守则由能力一处声明；provision 会 trim 归一（与其它能力同规）。
  buildPrompt: async () => DREAM_SYSTEM_PROMPT,
};
