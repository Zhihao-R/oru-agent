/**
 * 工具名前缀归一——全仓唯一实现，主进程与渲染层共用。
 *
 * claude-code 后端把 Oru 自有工具桥成名为 'oru' 的 MCP server（backends/claudeCode.ts），
 * 事件与落盘里的工具名带 mcp__oru__ 前缀（如 mcp__oru__ask_user_choice）；
 * anthropic / openai 后端给裸名。所有按工具名消费的地方（查表、取 stash、查 registry、
 * 上屏文案）统一走 normalizeToolName，不要各自手剥。
 *
 * 只剥 mcp__oru__ 一种前缀：mcp__<其他 server>__ 是真外部 MCP 工具的注册名
 * （见 electron/main/mcp/reflectTool.ts），剥成裸名会让外部工具冒充 Oru 自有工具
 * （末段撞名就走错分支），必须原样保留。
 */
export const ORU_MCP_TOOL_PREFIX = 'mcp__oru__';

export function normalizeToolName(name: string): string {
  return name.startsWith(ORU_MCP_TOOL_PREFIX) ? name.slice(ORU_MCP_TOOL_PREFIX.length) : name;
}

/** 外部 MCP 工具名（mcp__ 开头且非 Oru 自有桥名）——只读闸 fail-closed 判定用 */
export function isExternalMcpToolName(name: string): boolean {
  return name.startsWith('mcp__') && !name.startsWith(ORU_MCP_TOOL_PREFIX);
}
