/**
 * web_search / web_fetch 工具 smoke——验证：
 * 1. 工具注册到了正确的 usage
 * 2. enabled=false 时返回标准"未启用"错误文案
 * 3. enabled=true 且无引擎时返回"未配置"错误文案
 * 4. 预算超额时返回"已达硬上限"错误文案
 * 5. ClaudeCodeBackend.registerTool 跳过 web_search/web_fetch
 *
 * 不打真 API；不依赖网络。
 */
import './__smoke_isolate__';

import { __resetBudgetMapForTest, consumeBudget, getMaxBudget } from '../../electron/main/search/budget';
import { __resetFailureMapForTest } from '../../electron/main/search/selector';
import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';
import { makeWebSearchTool } from '../../electron/main/agent/agentTools/webSearch';
import { makeWebFetchTool } from '../../electron/main/agent/agentTools/webFetch';
import { updateSettings } from '../../electron/main/projects/store';
import type { ToolContext } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

function makeCtx(conversationId = 'cnv1'): ToolContext {
  return makeToolContext({
    conversationId,
    agentId: 'agt_test',
    ownerId: 'local-user',
    // 原工厂无 onProposal——webFetch 审批走背景路径（不执行、返回文案），保持语义
    onProposal: undefined,
  });
}

async function main() {
  __resetBudgetMapForTest();
  __resetFailureMapForTest();

  const webSearch = makeWebSearchTool();
  const webFetch = makeWebFetchTool();

  // ─── case 1: enabled=false ───
  await updateSettings({ webSearch: { enabled: false, engines: [], longPageSummary: true } });
  {
    const r = await webSearch.execute({ query: '测试' }, makeCtx());
    assert(
      r.isError === true && r.text.includes('上网搜索未启用'),
      'enabled=false 时 web_search 返回未启用错误',
      r.text,
    );
  }
  {
    const r = await webFetch.execute({ url: 'https://example.com' }, makeCtx());
    assert(
      r.isError === true && r.text.includes('上网搜索未启用'),
      'enabled=false 时 web_fetch 返回未启用错误',
      r.text,
    );
  }

  // ─── case 2: enabled=true 但 0 引擎 ───
  __resetBudgetMapForTest();
  await updateSettings({ webSearch: { enabled: true, engines: [], longPageSummary: true } });
  {
    const r = await webSearch.execute({ query: '测试' }, makeCtx());
    assert(
      r.isError === true && r.text.includes('上网搜索当前不可用'),
      'enabled=true 0 引擎 时 web_search 返回不可用 + 引导用户去 Settings',
      r.text,
    );
    assert(
      r.text.includes('Settings'),
      'web_search 错误文案包含"去 Settings 看一下"引导',
      r.text,
    );
  }

  // ─── case 3: 配假 key 后所有引擎失败 ───
  // 这一步需要触发真 HTTP 调用——为了不依赖网络，我们跳过这条；预算超额 case 已能覆盖错误路径

  // ─── case 4: 预算超额 ───
  __resetBudgetMapForTest();
  await updateSettings({ webSearch: { enabled: true, engines: [], longPageSummary: true } });
  // 把预算用完
  for (let i = 0; i < getMaxBudget(); i += 1) consumeBudget('cnvBudget');
  {
    const r = await webSearch.execute({ query: '测试' }, makeCtx('cnvBudget'));
    assert(
      r.isError === true && r.text.includes('硬上限'),
      '预算超额时 web_search 返回硬上限错误',
      r.text,
    );
  }
  {
    const r = await webFetch.execute({ url: 'https://example.com' }, makeCtx('cnvBudget'));
    assert(
      r.isError === true && r.text.includes('硬上限'),
      '预算超额时 web_fetch 返回硬上限错误',
      r.text,
    );
  }

  // ─── case 5: ClaudeCodeBackend 跳过 web_search/web_fetch ───
  {
    const backend = new ClaudeCodeBackend();
    backend.registerTool(webSearch);
    backend.registerTool(webFetch);
    // 私有字段访问——通过工具 list 间接验证：build mcp server 里只有 0 个工具会暴露
    // 但因 mcp server 构造依赖 ToolContext 闭包，简单点：检查 tools Map 大小
    // tools 字段是 private，用 unknown cast 验证
    const tools = (backend as unknown as { tools: Map<string, unknown> }).tools;
    assert(tools.size === 0, 'ClaudeCodeBackend.registerTool 跳过 web_search/web_fetch');
  }

  // ─── case 6: v0.4 persistPolicy 形态（替代旧的 shortSummarize 验证）───
  {
    assert(
      webSearch.persistPolicy === undefined || webSearch.persistPolicy === 'auto',
      'web_search persistPolicy 默认（auto）',
      String(webSearch.persistPolicy),
    );
    assert(webFetch.persistPolicy === 'always', 'web_fetch persistPolicy = always');
    assert(webFetch.persistExt === 'md', 'web_fetch persistExt = md');
  }

  const fail = RESULTS.filter((r) => !r.ok);
  if (fail.length > 0) {
    console.error(`\n${fail.length} 项失败`);
    process.exit(1);
  }
  console.log(`\n全部 ${RESULTS.length} 项通过`);
}

void main().catch((e) => {
  console.error('smoke 异常：', e);
  process.exit(1);
});
