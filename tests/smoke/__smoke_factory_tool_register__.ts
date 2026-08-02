/**
 * factory.registerTool + getBackendFor 的 usages 过滤 smoke
 *
 * 验证：
 * 1. registerTool(tool, ['twinMain']) 只让 twinMain 看见
 * 2. registerTool(tool, ['twinMain','twinBackground']) 让两路都看见
 * 3. getBackendFor 不缓存实例（两次调用返回不同对象）
 * 4. settings 没分配 model 时 fallback 到默认 ClaudeCodeBackend，工具仍按 usage 注入
 *
 * 不打 Claude
 */
import './__smoke_isolate__';
import type { AgentBackend, AgentTool } from '@shared/agent/backend';
import type { LlmUsage } from '@shared/types';
import {
  __clearToolRegistryForTest,
  __listRegisteredToolsForTest,
  getBackendFor,
  registerTool,
} from '../../electron/main/agent/backends';

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

/** 通过反射观察 backend 内部 tools Map（ClaudeCodeBackend 实现细节） */
function getBackendToolNames(backend: AgentBackend): string[] {
  // ClaudeCodeBackend 把 tools 存在私有 Map；用 'tools' 拿
  const tools = (backend as unknown as { tools: Map<string, AgentTool> }).tools;
  return Array.from(tools.keys()).sort();
}

async function main(): Promise<void> {
  console.log('=== factory_tool_register smoke ===');

  __clearToolRegistryForTest();

  // 注册 5 个工具，3 种 usage 组合
  const onlyMain = makeStubTool('only_main');
  const onlyBg = makeStubTool('only_bg');
  const onlySub = makeStubTool('only_sub');
  const mainAndBg = makeStubTool('main_and_bg');
  const allFour = makeStubTool('all_four');
  registerTool(onlyMain, ['twinMain']);
  registerTool(onlyBg, ['twinBackground']);
  registerTool(onlySub, ['subagentCoder']);
  registerTool(mainAndBg, ['twinMain', 'twinBackground']);
  registerTool(allFour, ['twinMain', 'twinBackground', 'memoryDream', 'subagentCoder']);

  assert(__listRegisteredToolsForTest().length === 5, '注册了 5 个工具', `count=${__listRegisteredToolsForTest().length}`);

  const expectations: Array<{ usage: LlmUsage; expected: string[] }> = [
    { usage: 'twinMain', expected: ['all_four', 'main_and_bg', 'only_main'] },
    { usage: 'twinBackground', expected: ['all_four', 'main_and_bg', 'only_bg'] },
    { usage: 'subagentCoder', expected: ['all_four', 'only_sub'] },
    { usage: 'memoryDream', expected: ['all_four'] },
  ];

  for (const { usage, expected } of expectations) {
    const backend = await getBackendFor(usage);
    const got = getBackendToolNames(backend);
    assert(
      JSON.stringify(got) === JSON.stringify(expected),
      `usage=${usage}: 工具集正确`,
      `expected=${expected.join(',')} got=${got.join(',')}`,
    );
  }

  // 不缓存实例：两次 getBackendFor('twinMain') 应该返回不同对象
  const a = await getBackendFor('twinMain');
  const b = await getBackendFor('twinMain');
  assert(a !== b, 'getBackendFor 不缓存实例（两次调用返回不同对象）');

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
