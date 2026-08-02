/**
 * v0.5 MCP registry smoke——验证关键路径不依赖真 spawn 子进程：
 * 1. Settings 默认值含 chrome-devtools-mcp 预设但 disabled
 * 2. reflectedToolName 命名规则
 * 3. registerTool / unregisterTool 通过 backends index 导出
 *
 * 原 case 3/4（ClaudeCodeBackend 跳过 mcp__ 前缀工具、透传 cache）随「外部 MCP 进程复用」
 * 退场删除——两者的唯一断言都是 assert(true)，删掉的是空壳不是覆盖。新机制（反射工具与自有
 * 工具同路桥进 'oru'）的真断言在 tests/agent/restrictToolsTo.test.ts。
 */
import './__smoke_isolate__';

import { getSettings } from '../../electron/main/projects/store';
import { reflectedToolName } from '../../electron/main/mcp/reflectTool';
import { registerTool, unregisterTool, __listRegisteredToolsForTest, __clearToolRegistryForTest } from '../../electron/main/agent/backends';
import type { AgentTool } from '@shared/agent/backend';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

function makeFakeTool(name: string): AgentTool {
  return {
    name,
    description: 'fake',
    inputSchema: { type: 'object' },
    async execute() {
      return { isError: false, text: 'ok' };
    },
  };
}

async function main() {
  // ─── case 1: 默认 Settings 含 chrome-devtools-mcp 预设 ───
  const settings = await getSettings();
  const servers = settings.mcpServers ?? [];
  const preset = servers.find((s) => s.id === 'preset-chrome-devtools');
  assert(!!preset, '默认 settings 含 preset-chrome-devtools');
  assert(preset?.enabled === false, '预设默认 disabled');
  assert(
    preset?.args.includes('--autoConnect') === true,
    '预设 args 含 --autoConnect（连用户日常 Chrome，走 Chrome 内部 IPC 不走 9222）',
  );
  assert(
    preset?.args.includes('--channel=stable') === true,
    '预设 args 含 --channel=stable（autoConnect 必需，指明连哪个 Chrome channel）',
  );
  assert(
    preset?.args.some((a) => a.startsWith('--userDataDir=')) === false,
    '预设 args 不含 --userDataDir=（autoConnect 模式下不该自己启 Chrome）',
  );
  assert(
    preset?.args.includes('--experimentalPageIdRouting') === true,
    '预设 args 含 --experimentalPageIdRouting',
  );
  assert(
    preset?.probeTool === undefined,
    '预设无 probeTool（chrome-devtools-mcp 0.26 懒启动 Chrome，probe 会触发不必要的 Chrome 拉起 / 授权弹窗）',
  );

  // ─── case 2: reflectedToolName 命名规则 ───
  {
    const n = reflectedToolName('preset-chrome-devtools', 'navigate_page');
    assert(n === 'mcp__preset-chrome-devtools__navigate_page', `命名规则: ${n}`);
  }

  // ─── case 3: registerTool / unregisterTool 通过 backends index 可用 ───
  __clearToolRegistryForTest();
  const before = __listRegisteredToolsForTest().length;
  const fakeTool = makeFakeTool('mcp__test__do_thing');
  registerTool(fakeTool, ['twinMain', 'twinBackground', 'subagentCoder']);
  const afterRegister = __listRegisteredToolsForTest();
  assert(
    afterRegister.length === before + 1,
    'registerTool 让 toolRegistry 多一项',
  );
  assert(
    afterRegister.some((e) => e.tool.name === 'mcp__test__do_thing'),
    'toolRegistry 含 mcp__test__do_thing',
  );
  unregisterTool('mcp__test__do_thing');
  const afterUnregister = __listRegisteredToolsForTest();
  assert(
    afterUnregister.length === before,
    'unregisterTool 让 toolRegistry 回到原大小',
  );

  // ─── 汇总 ───
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
