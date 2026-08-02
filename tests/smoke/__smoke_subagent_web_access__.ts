/**
 * 接通 smoke（验目标问题本身）—— 子 agent 能拿到联网工具。
 *
 * 这是迁移前会红、迁移后会绿的那个点：
 *   1. getBackendFor('subagentCoder') 的 backend 工具表含 web_search/web_fetch
 *      （证明"先 allow（removeFromIgnoredTools）后 inject"时序成立——此前被 ignored 名单静默吞掉）。
 *   2. provisionAgent('subagentCoder') 把 SDK 内置 WebSearch/WebFetch 放进 extraDisallowed（防两套并存）。
 *   3. 不破坏既有能力：ask_twin/report_progress/render_html 仍在 backend 工具表。
 *   4. 默认关闭得到尊重：enabled=false 时联网引导 prompt 不注入（模型不被诱导去搜）。
 *   5. 预算隔离（决策二）：子 agent 用独立 searchBudgetId，搜它不消耗主对话桶。
 *
 * 不打真实 API。
 */
import './__smoke_isolate__';
import type { AgentBackend, AgentTool } from '@shared/agent/backend';
import { getBackendFor } from '../../electron/main/agent/backends';
import { provisionAgent } from '../../electron/main/agent/capabilities';
import { updateSettings } from '../../electron/main/projects/store';
import {
  consumeBudget,
  getCurrentBudget,
  __resetBudgetMapForTest,
} from '../../electron/main/search/budget';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}

function backendToolNames(backend: AgentBackend): string[] {
  const tools = (backend as unknown as { tools: Map<string, AgentTool> }).tools;
  return Array.from(tools.keys()).sort();
}

async function main(): Promise<void> {
  console.log('=== subagent_web_access smoke ===');

  // ─── 1. 工具接通：subagentCoder backend 含 oru 联网工具 ───
  // 无 model 分配 → OAuth fallback → ClaudeCodeBackend（正是 ignored 名单生效的那条路）
  await updateSettings({ webSearch: { enabled: true } });
  const backend = await getBackendFor('subagentCoder');
  const names = backendToolNames(backend);
  assert(names.includes('web_search'), 'subagentCoder backend 含 web_search（removeFromIgnoredTools 生效）', names.join(','));
  assert(names.includes('web_fetch'), 'subagentCoder backend 含 web_fetch', names.join(','));

  // ─── 3. 不破坏既有能力 ───
  assert(names.includes('ask_twin'), '既有能力 ask_twin 仍在');
  assert(names.includes('report_progress'), '既有能力 report_progress 仍在');
  assert(names.includes('render_html'), '既有能力 render_html（任务 1）仍在');

  // ─── 2 + 4. provisionAgent：enabled=true 注入联网引导 + 禁 SDK 内置 ───
  const onEnabled = await provisionAgent({
    usage: 'subagentCoder',
    searchBudgetId: 'task_smoke',
    activeProjectId: null,
  });
  assert(
    onEnabled.extraDisallowed.includes('WebSearch') && onEnabled.extraDisallowed.includes('WebFetch'),
    'SDK 内置 WebSearch/WebFetch 进 extraDisallowed（防两套并存）',
    onEnabled.extraDisallowed.join(','),
  );
  assert(onEnabled.capabilityPrompt.includes('## 上网'), 'enabled=true：联网引导 prompt 注入', onEnabled.capabilityPrompt.slice(0, 40));
  assert(
    onEnabled.toolContextPatch.searchBudgetId === 'task_smoke',
    'toolContextPatch 带独立 searchBudgetId',
    String(onEnabled.toolContextPatch.searchBudgetId),
  );

  // ─── 2b. twinBackground 也走同一机制（修评审发现的半截不一致）───
  const bgProvision = await provisionAgent({
    usage: 'twinBackground',
    searchBudgetId: 'bg_smoke',
    activeProjectId: null,
  });
  assert(
    bgProvision.extraDisallowed.includes('WebSearch') && bgProvision.extraDisallowed.includes('WebFetch'),
    'twinBackground 同样禁 SDK 内置（联网机制一致供给，非半截迁移）',
    bgProvision.extraDisallowed.join(','),
  );

  // ─── 4. 默认关闭：enabled=false 时联网引导不注入 ───
  await updateSettings({ webSearch: { enabled: false } });
  const offProvision = await provisionAgent({
    usage: 'subagentCoder',
    searchBudgetId: 'task_smoke2',
    activeProjectId: null,
  });
  assert(!offProvision.capabilityPrompt.includes('## 上网'), 'enabled=false：联网引导 prompt 不注入（默认关闭得到尊重）');
  // 但 disallow 仍在（claudeCodeTools 是能力静态声明，不随 enabled 变）——SDK 内置始终禁，杜绝绕过预算的后门
  assert(offProvision.extraDisallowed.includes('WebSearch'), 'enabled=false：SDK 内置仍被禁（无预算后门）');

  // ─── 5. 预算隔离：子 agent 桶独立，搜它不动主对话桶 ───
  __resetBudgetMapForTest();
  const mainConvId = 'conv_main';
  // provisionAgent.initRuntime 已 reset 'task_smoke3'；模拟子 agent 连搜 3 次
  await provisionAgent({ usage: 'subagentCoder', searchBudgetId: 'task_smoke3', activeProjectId: null });
  consumeBudget('task_smoke3');
  consumeBudget('task_smoke3');
  consumeBudget('task_smoke3');
  assert(getCurrentBudget('task_smoke3') === 3, '子 agent 桶计数到 3', String(getCurrentBudget('task_smoke3')));
  assert(getCurrentBudget(mainConvId) === 0, '主对话桶不受子 agent 搜索影响（决策二）', String(getCurrentBudget(mainConvId)));

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
