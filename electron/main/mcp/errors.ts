/**
 * MCP client 错误分类（v0.5）。
 *
 * 跟 WebSearchError / BrowserError 完全隔离——只在 mcp/* 模块内 throw，
 * 被 reflectTool 的 catch 接住翻译成 ToolResult 错误文案。
 */

export type McpErrorKind =
  /** 子进程 spawn / MCP handshake 失败（细节进 message） */
  | 'start_failed'
  /** 调用时 server 还在 starting / 已 failed / probe_failed */
  | 'server_not_ready'
  /** 工具调用本身失败（handshake OK 但 server 返回 error） */
  | 'tool_call_failed';

export class McpError extends Error {
  constructor(
    public readonly kind: McpErrorKind,
    message?: string,
  ) {
    super(message ?? kind);
    this.name = 'McpError';
  }
}
