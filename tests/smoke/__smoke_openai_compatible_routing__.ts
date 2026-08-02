/**
 * OpenAICompatibleBackend 在 factory 里的路由 smoke
 *
 * 验证：
 * 1. openrouter / openai / zhipu / kimi 四种类型都路由到 OpenAICompatibleBackend，baseURL 对应默认值
 * 2. custom-openai 必须用户提供 baseUrl；不传抛错
 * 3. subagentCoder + 非 anthropic provider → 路由到通用 backend（决策 D1，不再"不允许"）
 * 4. 工具按 usages 过滤注入正确
 */
import './__smoke_isolate__';
import type { AgentTool } from '@shared/agent/backend';
import type { BackendProvider, LlmUsage } from '@shared/types';
import { __clearCacheForTest, updateSettings } from '../../electron/main/projects/store';
import { newProviderId, newRegisteredModelId } from '@shared/ids';
import {
  __clearToolRegistryForTest,
  getBackendFor,
  registerTool,
} from '../../electron/main/agent/backends';
import { OpenAICompatibleBackend } from '../../electron/main/agent/backends/openaiCompatible';

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

async function setupOnly(opts: {
  provider: Omit<BackendProvider, 'id'>;
  assignTo: LlmUsage;
}): Promise<void> {
  __clearCacheForTest();
  const providerId = newProviderId();
  const modelId = newRegisteredModelId();
  await updateSettings({
    providers: [{ id: providerId, ...opts.provider }],
    models: [
      { id: modelId, providerId, modelId: 'some-model', label: 'some-model' },
    ],
    modelAssignments: {
      twinMain: opts.assignTo === 'twinMain' ? modelId : null,
      twinBackground: opts.assignTo === 'twinBackground' ? modelId : null,
      memoryDream: opts.assignTo === 'memoryDream' ? modelId : null,
      subagentCoder: opts.assignTo === 'subagentCoder' ? modelId : null,
      conversationSummary: opts.assignTo === 'conversationSummary' ? modelId : null,
    },
    migratedFromManualApiKey: true,
  });
}

// 决策 D1（5019cd6）：非 anthropic 的 subagentCoder 不再"不允许"，改路由到通用 backend
// （构造 + 条件注入文件工具）。故这些 provider 应成功返回 backend，而非抛错。
async function expectSubagentRoutesToGeneralBackend(providerType: BackendProvider['type']): Promise<void> {
  await setupOnly({
    provider: { type: providerType, label: providerType, apiKey: 'sk-x' },
    assignTo: 'subagentCoder',
  });
  let backend: unknown = null;
  let threw = false;
  try {
    backend = await getBackendFor('subagentCoder');
  } catch {
    threw = true;
  }
  assert(!threw && backend != null, `subagentCoder + ${providerType} → 路由到通用 backend（D1，不再拒）`);
}

async function main(): Promise<void> {
  console.log('=== openai_compatible_routing smoke ===');

  __clearToolRegistryForTest();
  registerTool(makeStubTool('main_only'), ['twinMain'] as LlmUsage[]);

  // case 1-4: 四种已知 type 走 OpenAICompatibleBackend
  const types: Array<{ t: BackendProvider['type']; expectBaseURL: string }> = [
    { t: 'openrouter', expectBaseURL: 'https://openrouter.ai/api/v1' },
    { t: 'openai', expectBaseURL: 'https://api.openai.com/v1' },
    { t: 'zhipu', expectBaseURL: 'https://open.bigmodel.cn/api/paas/v4' },
    { t: 'kimi', expectBaseURL: 'https://api.moonshot.cn/v1' },
  ];
  for (const { t, expectBaseURL } of types) {
    await setupOnly({
      provider: { type: t, label: t, apiKey: 'sk-x' },
      assignTo: 'twinMain',
    });
    const backend = await getBackendFor('twinMain');
    assert(backend instanceof OpenAICompatibleBackend, `${t} → OpenAICompatibleBackend`, backend.constructor.name);
    const ready = await backend.isReady();
    assert(ready.ok, `${t}: isReady ok`, ready.hint);
    assert(ready.hint.includes(expectBaseURL), `${t}: hint 含默认 baseURL`, ready.hint);
  }

  // case 5: custom-openai 不传 baseUrl 抛错
  await setupOnly({
    provider: { type: 'custom-openai', label: 'custom', apiKey: 'sk-x' },
    assignTo: 'twinMain',
  });
  let threw = false;
  try {
    await getBackendFor('twinMain');
  } catch {
    threw = true;
  }
  assert(threw, 'custom-openai 不传 baseUrl → factory 抛错');

  // case 6: custom-openai 传 baseUrl 成功
  await setupOnly({
    provider: { type: 'custom-openai', label: 'custom', apiKey: 'sk-x', baseUrl: 'https://my.proxy/v1' },
    assignTo: 'twinMain',
  });
  const customBackend = await getBackendFor('twinMain');
  assert(customBackend instanceof OpenAICompatibleBackend, 'custom-openai 带 baseUrl → OpenAICompatibleBackend');
  const ready = await customBackend.isReady();
  assert(ready.hint.includes('my.proxy'), 'custom-openai: hint 含自定义 baseURL', ready.hint);

  // case 7-10: subagentCoder + 这四种非 anthropic type 都路由到通用 backend（D1，不再拒）
  for (const t of ['openrouter', 'openai', 'zhipu', 'kimi'] as const) {
    await expectSubagentRoutesToGeneralBackend(t);
  }

  // case 11: 工具按 usages 注入
  await setupOnly({
    provider: { type: 'openrouter', label: 'OR', apiKey: 'sk-x' },
    assignTo: 'twinMain',
  });
  const b11 = await getBackendFor('twinMain');
  const tools = (b11 as unknown as { tools: Map<string, AgentTool> }).tools;
  assert(tools.has('main_only'), 'OpenAICompatibleBackend(twinMain) 注入了 main_only', Array.from(tools.keys()).join(','));

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
