/**
 * S31·G47 声明式能力全量迁移 · 行为保持：render_html 与 dream 记忆整理迁成声明式能力后，工具对各受众的
 * 可见性逐位一致；dream 的 system 守则来源改经 provisionAgent，内容不变——仅经能力系统统一 trim 归一
 * （去掉守则尾部空白，与 web-search 等其它能力同规，对 LLM 无影响），故断言 === DREAM_SYSTEM_PROMPT.trim()。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerStaticAgentTools } from '../../electron/main/agent/agentTools/index';
import { registerBuiltinCapabilities, provisionAgent } from '../../electron/main/agent/capabilities';
import { __clearToolRegistryForTest, __listRegisteredToolsForTest } from '../../electron/main/agent/backends';
import { __clearCapabilityRegistryForTest } from '../../electron/main/agent/capabilities/registry';
import { DREAM_SYSTEM_PROMPT } from '../../electron/main/prompts/dream';

function usagesOf(name: string): string[] | null {
  const e = __listRegisteredToolsForTest().find((x) => x.tool.name === name);
  return e ? [...e.usages].sort() : null;
}

beforeEach(() => {
  __clearToolRegistryForTest();
  __clearCapabilityRegistryForTest();
  registerStaticAgentTools();
  registerBuiltinCapabilities();
});
afterEach(() => {
  __clearToolRegistryForTest();
  __clearCapabilityRegistryForTest();
});

describe('render_html 迁声明式能力', () => {
  it('仍对 twinMain / twinBackground / subagentCoder 可见（原 WEB 桶），且只注册一次', () => {
    expect(usagesOf('render_html')).toEqual(['subagentCoder', 'twinBackground', 'twinMain']);
    const hits = __listRegisteredToolsForTest().filter((x) => x.tool.name === 'render_html');
    expect(hits).toHaveLength(1); // 无双注册
  });
});

describe('dream 记忆整理迁声明式能力', () => {
  it('dream 专属工具（需全局视角）仍只注册到 memoryDream', () => {
    for (const name of ['read_conversation', 'merge_episodes']) {
      expect(usagesOf(name), name).toEqual(['memoryDream']);
    }
  });

  it('correct/retire_episode 对话侧开放（S35·G102）：memoryDream + twinMain', () => {
    for (const name of ['correct_episode', 'retire_episode']) {
      expect(usagesOf(name), name).toEqual(['memoryDream', 'twinMain']);
    }
  });

  it('共享记忆读写工具仍是主对话/后台/dream 三方可见（留在 factory 多受众桶）', () => {
    for (const name of ['grep_memory', 'read_memory', 'query_episodes', 'write_memory', 'edit_memory']) {
      expect(usagesOf(name), name).toEqual(['memoryDream', 'twinBackground', 'twinMain']);
    }
  });

  it('provisionAgent(memoryDream) 的 capabilityPrompt 就是 dream 守则（systemContext 来源不变）', async () => {
    const provision = await provisionAgent({ usage: 'memoryDream', searchBudgetId: 'dream', activeProjectId: null });
    expect(provision.capabilityPrompt).toBe(DREAM_SYSTEM_PROMPT.trim());
  });
});
