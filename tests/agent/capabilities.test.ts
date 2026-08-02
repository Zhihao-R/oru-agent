/**
 * 声明式能力供给 —— 注册表过滤 + provisionAgent 聚合（纯函数，不碰 store / settings）。
 *
 * 用 stub 能力验证机制本身：
 * - getCapabilitiesForUsage 按 audience 过滤；memoryDream 现为一等受众（S31·G47）、只命中声明它的能力。
 * - provisionAgent 聚合 prompt / toolContextPatch / extraDisallowed；空串 prompt 被过滤。
 * - 声明一次即覆盖：给能力 audience 加一个 usage，该 usage 的 provision 立即包含它（验收 §6）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCapability,
  getCapabilitiesForUsage,
  __clearCapabilityRegistryForTest,
} from '../../electron/main/agent/capabilities/registry';
import { provisionAgent } from '../../electron/main/agent/capabilities/provision';
import type { Capability } from '../../electron/main/agent/capabilities/types';

const baseCtx = { searchBudgetId: 'bucket-1', activeProjectId: null as string | null };

beforeEach(() => {
  __clearCapabilityRegistryForTest();
});

describe('getCapabilitiesForUsage', () => {
  it('空注册表返回空', () => {
    expect(getCapabilitiesForUsage('subagentCoder')).toEqual([]);
  });

  it('按 audience 过滤；memoryDream 作为一等受众可命中（S31·G47）', () => {
    const a: Capability = { id: 'a', audience: ['twinMain', 'subagentCoder'] };
    const b: Capability = { id: 'b', audience: ['subagentCoder'] };
    const c: Capability = { id: 'c', audience: ['memoryDream'] }; // 记忆整理专属能力
    registerCapability(a);
    registerCapability(b);
    registerCapability(c);
    expect(getCapabilitiesForUsage('subagentCoder').map((x) => x.id)).toEqual(['a', 'b']);
    expect(getCapabilitiesForUsage('twinMain').map((x) => x.id)).toEqual(['a']);
    // memoryDream 现是 AgentUsage：只命中声明了它的能力，不误纳别人（统一裁剪）
    expect(getCapabilitiesForUsage('memoryDream').map((x) => x.id)).toEqual(['c']);
  });
});

describe('provisionAgent 聚合', () => {
  it('拼 prompt（过滤空串）+ 合 disallowed + merge toolContextPatch', async () => {
    registerCapability({
      id: 'web',
      audience: ['subagentCoder'],
      buildPrompt: async () => '联网引导',
      initRuntime: async (ctx) => ({ searchBudgetId: ctx.searchBudgetId }),
      claudeCodeTools: { allow: ['web_search'], disallow: ['WebSearch', 'WebFetch'] },
    });
    registerCapability({
      id: 'claude-md',
      audience: ['subagentCoder'],
      buildPrompt: async () => '## CLAUDE.md\n规范内容',
    });
    registerCapability({
      id: 'empty-prompt',
      audience: ['subagentCoder'],
      buildPrompt: async () => '', // 空串应被过滤，不留空段
    });

    const p = await provisionAgent({ usage: 'subagentCoder', ...baseCtx });
    expect(p.capabilityPrompt).toBe('联网引导\n\n---\n\n## CLAUDE.md\n规范内容');
    expect(p.extraDisallowed).toEqual(['WebSearch', 'WebFetch']);
    expect(p.toolContextPatch).toEqual({ searchBudgetId: 'bucket-1' });
  });

  it('无命中能力 → 全空结果', async () => {
    registerCapability({ id: 'only-main', audience: ['twinMain'], buildPrompt: async () => 'x' });
    const p = await provisionAgent({ usage: 'subagentCoder', ...baseCtx });
    expect(p.capabilityPrompt).toBe('');
    expect(p.extraDisallowed).toEqual([]);
    expect(p.toolContextPatch).toEqual({});
  });

  it('声明一次即覆盖：audience 加一个 usage，该 usage 立即包含（无需改别处）', async () => {
    // 同一个 capability 对象，audience 含 twinBackground——给它新增受众即生效
    registerCapability({
      id: 'shared',
      audience: ['twinMain', 'twinBackground'],
      buildPrompt: async () => '共享能力',
    });
    const bg = await provisionAgent({ usage: 'twinBackground', ...baseCtx });
    expect(bg.capabilityPrompt).toBe('共享能力');
    // 未列入受众的 usage 不获得
    const sub = await provisionAgent({ usage: 'subagentCoder', ...baseCtx });
    expect(sub.capabilityPrompt).toBe('');
  });
});
