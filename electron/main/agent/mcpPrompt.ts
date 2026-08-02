/**
 * 外部 MCP server 使用规范（v0.5）——静态规范拼进 stableSystemContext。
 *
 * MCP 自管规范无条件拼接；chrome-devtools 有专属详细指引。探活失败的「该服务不可用勿调用」
 * 提示（G104，对所有 enabled server 通用）读的是运行时状态——应用启动期 server 从 starting
 * 到 connected 的翻转会改产物，故不进第一层：主对话由 buildRuntimeContext 拼进动态层，
 * scheduledTasks/executor 与 twinBackgroundQuery 两条一次性会话路径各自补拼。
 */
import type { McpServerRuntimeState } from '../mcp/types';
import { getSettings } from '../projects/store';
import { getRuntimeState } from '../mcp/registry';
import { MCP_SELF_MANAGE_GUIDE } from '../prompts/mcpSelfManage';
import { CHROME_DEVTOOLS_GUIDE } from '../prompts/chromeDevtools';

export { MCP_SELF_MANAGE_GUIDE, CHROME_DEVTOOLS_GUIDE };

/**
 * 「可达」= handshake 已通（connected / connected_ready），或 probe_failed。
 * probe_failed 算可达：其工具仍注册、调用时返回明确错误——让错误说话（M3 既定取舍），
 * 不在系统语境再警告，避免双重信号让模型困惑。其余（无 state / starting / failed /
 * reconnecting / idle）= 完全不可达，进通用提示。
 */
function isReachable(state: McpServerRuntimeState | undefined): boolean {
  return (
    !!state &&
    (state.status === 'connected' ||
      state.status === 'connected_ready' ||
      state.status === 'probe_failed')
  );
}

/** 静态规范（自管 + chrome-devtools 指引）——不读运行时状态，产物会话期逐字节稳定。 */
export async function loadMcpPromptIfEnabled(): Promise<string> {
  const settings = await getSettings();
  const enabled = (settings.mcpServers ?? []).filter((s) => s.enabled);

  // MCP 自管规范无条件拼接——分身随时可能被问"能装什么"，需要知道有 mcp_* 工具
  const parts: string[] = [MCP_SELF_MANAGE_GUIDE];

  if (enabled.some((s) => s.id === 'preset-chrome-devtools')) {
    parts.push(CHROME_DEVTOOLS_GUIDE);
  }

  return parts.join('\n\n---\n\n');
}

/**
 * 通用探活失败提示（G104）：逐个点名不可达的 enabled server，指示模型别调其工具、
 * 如实告知用户——避免模型看不到工具后静默改用别的路径硬试（如 web_fetch 撞登录态站点）。
 * 全部可达 / 无 enabled server → 空串。读运行时状态，只允许拼进动态层。
 */
export async function buildUnreachableNote(): Promise<string> {
  const settings = await getSettings();
  const down = (settings.mcpServers ?? [])
    .filter((s) => s.enabled)
    .map((s) => ({ label: s.label, state: getRuntimeState(s.id) }))
    .filter((s) => !isReachable(s.state));
  if (down.length === 0) return '';
  const lines = down
    .map((s) => {
      const reason = s.state?.lastError
        ? `原因：${s.state.lastError}`
        : s.state?.status
          ? `状态：${s.state.status}`
          : '尚未启动';
      return `- **${s.label}**（${reason}）`;
    })
    .join('\n');
  return (
    '### 部分外部服务当前不可用\n\n' +
    '以下已启用的外部服务（MCP）暂时连不上，**别调用它们的工具**——会失败得很难看。' +
    '用户问到需要这些服务的事，直接如实告诉他"该能力暂时不可用，稍等几秒重试；或者换个不依赖它的做法/把内容贴给我"：\n' +
    lines
  );
}
