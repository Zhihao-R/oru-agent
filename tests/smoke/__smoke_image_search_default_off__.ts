/**
 * __smoke_image_search_default_off__ —— PRD 验收 #5：未配联网时配图优雅退化。
 *
 * 全新 ORU_DIR（webSearch 未启用）下调 image_search → 被 loadConfigs 的 not_enabled 挡在
 * 任何对外请求之前：断言 isError、文案引导去配联网、且 **global.fetch 一次都没被调**
 * （不发起搜图、不下载、不产生费用——搜图可用性挂在联网闸门上，非独立开关）。
 */
import './__smoke_isolate__';
import type { ToolContext } from '@shared/agent/backend';
import { makeImageSearchTool } from '../../electron/main/agent/agentTools/imageSearch';

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

async function main(): Promise<void> {
  console.log('=== image_search default-off smoke ===');

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  }) as typeof globalThis.fetch;

  const ctx: ToolContext = {
    conversationId: 'cnv-off',
    agentId: 'agent-off',
    ownerId: 'local-user',
    usage: 'subagentCoder',
    approvalMode: 'work',
    abortSignal: new AbortController().signal,
  };

  try {
    const r = await makeImageSearchTool().execute({ query: '团队协作' }, ctx);
    assert(r.isError, 'webSearch 未启用时 image_search 应 isError');
    assert(/未启用|联网/.test(r.text), `文案应引导去配联网，得到：${r.text}`);
    assert(fetchCalls === 0, `不应发起任何对外请求，实际 fetch ${fetchCalls} 次`);
    assert(!r.images || r.images.length === 0, '不应返回任何缩略图');
    console.log('✓ 未配联网：image_search 退化为 isError、零对外请求、零下载');
    console.log('\n[IMAGE SEARCH DEFAULT-OFF SMOKE PASSED]');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
