/**
 * AnthropicBackend 路由和基础属性 smoke
 *
 * 验证：
 * 1. 用户配置 anthropic provider + 给 twinMain 分配 sonnet → factory 返回 AnthropicBackend
 * 2. 同一 provider 给 subagentCoder 分配 → factory 返回 ClaudeCodeBackend（不读 provider apiKey）
 * 3. 没分配 → fallback 到 ClaudeCodeBackend（保留现有 OAuth 路径）
 * 4. AnthropicBackend.isReady：apiKey 非空 → ok=true；空 → ok=false
 * 5. AnthropicBackend 接住 factory 注入的工具
 *
 * 不打真 Anthropic API
 */
import './__smoke_isolate__';
import type { AgentTool } from '@shared/agent/backend';
import type { LlmUsage } from '@shared/types';
import { __clearCacheForTest, updateSettings } from '../../electron/main/projects/store';
import { newProviderId, newRegisteredModelId } from '@shared/ids';
import {
  __clearToolRegistryForTest,
  getBackendFor,
  registerTool,
} from '../../electron/main/agent/backends';
import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function makeStubTool(name: string): AgentTool {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { text: `${name} ran` };
    },
  };
}

async function setupSettings(opts: {
  withAnthropicProvider: boolean;
  apiKey?: string;
  assignTwinMain?: boolean;
  assignSubagent?: boolean;
}): Promise<void> {
  __clearCacheForTest();
  const providerId = newProviderId();
  const modelId = newRegisteredModelId();
  await updateSettings({
    providers: opts.withAnthropicProvider
      ? [
          {
            id: providerId,
            type: 'anthropic',
            label: 'Anthropic',
            apiKey: opts.apiKey ?? '',
          },
        ]
      : [],
    models: opts.withAnthropicProvider
      ? [
          {
            id: modelId,
            providerId,
            modelId: 'claude-sonnet-4-6',
            label: 'Sonnet 4.6',
          },
        ]
      : [],
    modelAssignments: {
      twinMain: opts.assignTwinMain && opts.withAnthropicProvider ? modelId : null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: opts.assignSubagent && opts.withAnthropicProvider ? modelId : null,
      conversationSummary: null,
    },
    migratedFromManualApiKey: true,
  });
}

async function main(): Promise<void> {
  console.log('=== anthropic_routing smoke ===');

  __clearToolRegistryForTest();
  registerTool(makeStubTool('main_only'), ['twinMain'] as LlmUsage[]);
  registerTool(makeStubTool('sub_only'), ['subagentCoder'] as LlmUsage[]);
  // S02 写入路径收口回归：文件工具不再被 SDK subagentCoder 路径 skip（SDK Write/Edit 已禁，
  // coder 的写能力只来自 mcp__oru__ 守卫链工具）——用与生产同名的 stub 验注入。
  registerTool(makeStubTool('write_file'), ['twinMain', 'subagentCoder'] as LlmUsage[]);
  registerTool(makeStubTool('read_file'), ['twinMain', 'subagentCoder'] as LlmUsage[]);

  // case 1: anthropic provider + 给 twinMain 分配 → AnthropicBackend
  await setupSettings({
    withAnthropicProvider: true,
    apiKey: 'sk-anth-real',
    assignTwinMain: true,
  });
  const b1 = await getBackendFor('twinMain');
  assert(b1 instanceof AnthropicBackend, 'twinMain + anthropic provider → AnthropicBackend', b1.constructor.name);
  assert(b1.backendType === 'anthropic', 'backendType === anthropic', b1.backendType);
  assert(b1.toolProtocol === 'anthropic-native', 'toolProtocol === anthropic-native', b1.toolProtocol);
  const r1 = await b1.isReady();
  assert(r1.ok, 'isReady ok（apiKey 非空）', r1.hint);

  // case 2: anthropic provider + apiKey 空 → AnthropicBackend.isReady ok=false
  await setupSettings({ withAnthropicProvider: true, apiKey: '', assignTwinMain: true });
  const b2 = await getBackendFor('twinMain');
  assert(b2 instanceof AnthropicBackend, 'apiKey 空仍构造 AnthropicBackend');
  const r2 = await b2.isReady();
  assert(!r2.ok, 'apiKey 空：isReady ok=false', r2.hint);

  // case 3: 同 provider 给 subagentCoder → 仍 ClaudeCodeBackend
  await setupSettings({
    withAnthropicProvider: true,
    apiKey: 'sk-anth-real',
    assignSubagent: true,
  });
  const b3 = await getBackendFor('subagentCoder');
  assert(b3 instanceof ClaudeCodeBackend, 'subagentCoder + anthropic provider → ClaudeCodeBackend', b3.constructor.name);
  // case 3b（S02）：文件工具注入 SDK subagentCoder，不再被 skip
  const b3Tools = Array.from((b3 as unknown as { tools: Map<string, AgentTool> }).tools.keys());
  assert(
    b3Tools.includes('write_file') && b3Tools.includes('read_file'),
    'subagentCoder@ClaudeCodeBackend 注入文件工具（S02 收口后不再 skip）',
    b3Tools.join(','),
  );

  // case 4: 没配 provider 也没分配 → twinMain fallback ClaudeCodeBackend
  await setupSettings({ withAnthropicProvider: false });
  const b4 = await getBackendFor('twinMain');
  assert(b4 instanceof ClaudeCodeBackend, '无 provider/分配：fallback ClaudeCodeBackend');

  // case 5: 工具按 usages 过滤注入到 AnthropicBackend
  await setupSettings({
    withAnthropicProvider: true,
    apiKey: 'sk-anth-real',
    assignTwinMain: true,
  });
  const b5 = await getBackendFor('twinMain');
  // 反射看 backend 内部 tools
  const tools = (b5 as unknown as { tools: Map<string, AgentTool> }).tools;
  const names = Array.from(tools.keys()).sort();
  assert(
    names.includes('main_only') && !names.includes('sub_only'),
    'AnthropicBackend(twinMain) 注入 main_only 不注入 sub_only',
    names.join(','),
  );

  // 总结
  const failed = RESULTS.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nFAIL: ${failed.length}/${RESULTS.length}`);
    process.exit(1);
  }
  console.log(`\nPASS: all ${RESULTS.length} cases`);
}

main().catch((e) => {
  console.error('smoke unhandled error:', e);
  process.exit(1);
});
