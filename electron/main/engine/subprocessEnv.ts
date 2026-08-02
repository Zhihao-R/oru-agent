/**
 * claude-code SDK 子进程的环境变量构造——全仓库唯一入口。
 *
 * 背景：SDK spawn claude 子进程时 env 整包透传，shell 里残留的 ANTHROPIC_BASE_URL
 * 会把子进程的全部 API 请求劫持到第三方地址（docs/bug/2026-06-09）。这里统一剥掉。
 *
 * 注意：外部 MCP server 子进程（mcp/client.ts）刻意**不走**本函数——
 * 第三方 server（用户自配）可能合法需要 ANTHROPIC_BASE_URL。
 */
export function buildSubprocessEnv(apiKey?: string | null): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_BASE_URL;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}
