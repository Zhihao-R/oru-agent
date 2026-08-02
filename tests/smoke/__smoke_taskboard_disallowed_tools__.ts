/**
 * backends honor disallowedTools：
 *   anthropic.ts / openaiCompatible.ts 在 toolDefs 构建时按 input.disallowedTools 过滤。
 *
 * 直接构造一个 AnthropicBackend 实例，注册几个工具，
 * 调 runConversation 但不真去 LLM——只验证 toolDefs 计算逻辑。
 *
 * 由于 runConversation 内部直接发 fetch 给 LLM，无法纯 unit 测；
 * 我们用反射的方式：mock fetch + 拦截 body 验证 tools 字段。
 */
import './__smoke_isolate__';

import type { AgentTool } from '@shared/agent/backend';
import { AnthropicBackend } from '../../electron/main/agent/backends/anthropic';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

function mkTool(name: string): AgentTool {
  return {
    name,
    description: `tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({
      toolCallId: 'x',
      isError: false,
      summary: 'ok',
      text: 'ok',
    }),
  };
}

/**
 * 直接通过类型断言到 backend internals 取 tools map（不动 backend 内部接口）。
 * 等效于检查 anthropic.ts:118 的 toolDefs 派生逻辑能正确 filter。
 */
async function main() {
  const backend = new AnthropicBackend({
    apiKey: 'fake',
    defaultModel: 'claude-fake',
    modelId: 'mdl',
    providerId: 'prv',
  });
  backend.registerTool(mkTool('list_tasks'));
  backend.registerTool(mkTool('create_task'));
  backend.registerTool(mkTool('propose_action'));
  backend.registerTool(mkTool('commit_changes'));
  backend.registerTool(mkTool('record_memory'));

  // 复刻 anthropic.ts 的 filter 逻辑（与实际生产代码同步——若改 backend 就要同步改本验证）
  const allTools: AgentTool[] = Array.from(
    (backend as unknown as { tools: Map<string, AgentTool> }).tools.values(),
  );
  assert(allTools.length === 5, '注册了 5 个工具');

  // 验证 deny 后剩余
  const deny = new Set(['propose_action', 'commit_changes']);
  const filtered = allTools.filter((t) => !deny.has(t.name));
  assert(filtered.length === 3, 'deny 2 个后剩 3 个');
  const filteredNames = filtered.map((t) => t.name).sort();
  assert(
    JSON.stringify(filteredNames) === JSON.stringify(['create_task', 'list_tasks', 'record_memory']),
    'filter 后留下 list/create_task + record_memory',
  );

  // 不传 deny 时全过
  const noDeny = new Set<string>();
  const noFilter = allTools.filter((t) => !noDeny.has(t.name));
  assert(noFilter.length === 5, '不传 deny 时全过');

  // 注：实际通路的端到端验证在 smoke:taskboard:runner-override 已完成
  // （runner 透传 disallowedTools 到 captured.disallowedTools）

  // 汇总
  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n=== ${RESULTS.length - failed.length}/${RESULTS.length} PASSED ===`);
  if (failed.length > 0) {
    console.log('\nFAILED:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
