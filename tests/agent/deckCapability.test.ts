/**
 * P4 deck 路由迁声明式能力：路由文本从第一层（stableSystemContext）移到第二层
 * （capabilityPrompt），deck 文案变动不再击穿子 agent 共享的第一断点缓存。
 *
 * 验三件事：
 * - audience 必须同时含 twinMain 与 twinSubagent——capability registry 是纯 audience
 *   过滤、不继承（工具桶的 twinSubagent 透明继承不适用），只写 twinMain 会让持有
 *   propose_deck_create 的对话期 subagent 丢路由段；
 * - 注册顺序 image 紧跟 deck（两段在 capabilityPrompt 里相邻）；
 * - 未列受众（scheduledRun 等）不获得路由段——定时任务路径本就不 provision deck 工具。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerBuiltinCapabilities, provisionAgent } from '../../electron/main/agent/capabilities';
import {
  __clearCapabilityRegistryForTest,
  __listCapabilitiesForTest,
} from '../../electron/main/agent/capabilities/registry';
import { __clearToolRegistryForTest } from '../../electron/main/agent/backends';
import { DECK_ROUTING_HINT } from '../../electron/main/prompts/deckRouting';

beforeEach(() => {
  __clearToolRegistryForTest();
  __clearCapabilityRegistryForTest();
  registerBuiltinCapabilities();
});
afterEach(() => {
  __clearToolRegistryForTest();
  __clearCapabilityRegistryForTest();
});

const ctx = { searchBudgetId: 'bucket-deck-test', activeProjectId: null as string | null };

describe('deck 路由声明式能力', () => {
  it('twinMain 与 twinSubagent 的 capabilityPrompt 都含路由段', async () => {
    for (const usage of ['twinMain', 'twinSubagent'] as const) {
      const p = await provisionAgent({ usage, ...ctx });
      expect(p.capabilityPrompt, usage).toContain(DECK_ROUTING_HINT.trim());
    }
  });

  it('scheduledRun / twinBackground / subagentCoder 不获得路由段', async () => {
    for (const usage of ['scheduledRun', 'twinBackground', 'subagentCoder'] as const) {
      const p = await provisionAgent({ usage, ...ctx });
      expect(p.capabilityPrompt, usage).not.toContain('propose_deck_create');
    }
  });

  it('注册顺序 image 紧跟 deck——两段在 capabilityPrompt 里相邻', () => {
    const ids = __listCapabilitiesForTest().map((c) => c.id);
    const deckIdx = ids.indexOf('deck');
    expect(deckIdx).toBeGreaterThanOrEqual(0);
    expect(ids[deckIdx + 1]).toBe('image');
  });
});
