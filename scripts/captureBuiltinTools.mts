/**
 * 真机抓 Claude Agent SDK 当前内置工具全名单（D3-a 的取定来源）。
 *
 * 用途：升级 @anthropic-ai/claude-agent-sdk 后重跑本脚本，把输出更新进
 * electron/main/agent/backends/claudeCode.ts 的 `SDK_BUILTIN_TOOLS_<版本>` 冻结快照，
 * 并复核新增工具该不该进 BUILTIN_ALLOWLIST。
 *
 * 原理：SDK 在 session 起始发 `SDKSystemMessage(subtype:'init')`，其 `tools` 字段就是模型
 * 实际拿到的内置工具全名单——比 grep 压缩 cli.js（名字会被 minify/构造，抓不全）可靠。
 * preset claude_code + settingSources 隔离 → 纯内置工具集（不含项目 MCP / skill 注入）。
 *
 * 跑法：node --import tsx scripts/captureBuiltinTools.mts
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

const ac = new AbortController();
const q = query({
  prompt: 'hi',
  options: {
    cwd: process.cwd(),
    abortController: ac,
    settingSources: undefined, // 隔离：不加载 user/project/local settings → 纯内置工具集
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // tools 不传 = preset claude_code 默认全量内置工具（等价默认路径 builtinTools:undefined）
  } as never,
});

try {
  for await (const msg of q as AsyncIterable<{ type: string; subtype?: string; tools?: string[]; mcp_servers?: unknown }>) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      console.log('SDK builtin tools (init.tools):');
      console.log(JSON.stringify(msg.tools, null, 2));
      console.log('mcp_servers:', JSON.stringify(msg.mcp_servers));
      ac.abort();
      break;
    }
  }
} catch (e) {
  // init 消息在首个模型回合前到达，正常情况下不会因 abort 报错；其余错误打印供排查
  console.error('capture error:', e instanceof Error ? e.message : String(e));
}
process.exit(0);
