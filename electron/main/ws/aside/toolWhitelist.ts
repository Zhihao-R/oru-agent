/**
 * 随手评点（aside）短聊的只读工具白名单（技术方案 §7）。
 *
 * 入选标准（三条全过）：纯读、无卡片、无副作用。短聊的手只有「看一眼再说」——
 * 读文件、搜记忆、看项目环境；propose / execute / write / ask / escalate / task 族一律不进。
 * 正向枚举：漏列的后果是「少个工具」，不是「多个洞」。
 *
 * 入选成员（对照 agentTools/index.ts 注册表逐一核对）：
 * - read_file / list_dir / grep / glob：本地文件读四件，纯读无副作用
 * - read_memory / grep_memory / query_episodes：记忆只读三件（record/edit 是写，不进）
 * - list_projects / get_project_detail：项目环境纯读——runtimeContext 保留的
 *   target_project_id 指引与这两件配套
 *
 * 主要落选族及判据（新工具入册时照此对照）：
 * - 写/执行族（write_file / edit_file / manage_files / bash / commit_changes / generate_deck…）：动手
 * - 提案族（propose_deck_create / propose_*_install / mcp_install…）：
 *   信任模式直通真实执行，审批模式回调缺席返假成功
 * - 提问/上报（ask_user_choice / escalate_to_user）：浮层无提问渲染面，会挂死整轮
 * - task：短聊不派 subagent（subagentSupport 缺席时真 isError，放进来也只会报错）
 * - activate_plugin / read_skill：执行即落 chip 卡片（违「无卡片」）
 * - 管理类纯读（list_tasks / mcp_list / mcp_inspect / plugin_list / artifact_history_list）：
 *   纯读但服务管理工作流，与「就着点的这块内容聊」无关——克制不进，需要再加
 * - web_search / web_fetch / view_slide / render_contact_sheet：外呼或离屏渲染副作用，
 *   且其用法说明（capabilityPrompt）在 aside 回合已被裁掉，给了也不会用对
 * - mcp_test_connection 与外部 MCP 反射工具：真实外呼/执行，无提案闸
 */
import { listRegisteredToolNames } from '../../agent/backends/factory';

export const ASIDE_TOOL_WHITELIST: readonly string[] = [
  'read_file',
  'list_dir',
  'grep',
  'glob',
  'read_memory',
  'grep_memory',
  'query_episodes',
  'list_projects',
  'get_project_detail',
];

/**
 * 兜底 denylist = 注册表全量 − 白名单。Anthropic / OpenAICompatible 的第二层保险
 * （它们按裸名过滤请求体，denylist 真实生效）；ClaudeCode 的裸名 denylist 因
 * mcp__oru__ 前缀静默失效，它的收口靠 restrictToolsTo 的两面（T4）。
 * 每轮现算——外部 MCP 反射工具运行时动态注册，启动期快照会漏。
 */
export function buildAsideToolDenylist(): string[] {
  const allow = new Set(ASIDE_TOOL_WHITELIST);
  return listRegisteredToolNames().filter((name) => !allow.has(name));
}
