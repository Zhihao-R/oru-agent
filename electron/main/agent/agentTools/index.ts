/**
 * 把 AgentTool 集中导出 + 提供"批量注册到 factory"helper
 */
import type { LlmUsage } from '@shared/types';
import { registerTool } from '../backends';
import { createMemoryTools } from '../../memory/tools';
import { createEpisodeCorrectionTools } from '../../memory/dreamTools';
import { makeCommitChangesTool } from './commitChanges';
import { makeListProjectsTool, makeGetProjectDetailTool } from './projects';
import { makeEscalateToUserTool } from './escalate';
import { makeAskTwinTool, makeReportProgressTool } from './subagent';
// web_search/web_fetch 不再由此注册——迁到 capabilities/builtins/webSearch.ts（单源）
import { makeReadFileTool } from './readFile';
import {
  makeCreateTaskTool,
  makeDeleteTaskTool,
  makeListTasksTool,
  makeRestoreTaskTool,
  makeUpdateTaskTool,
} from './taskboard';
import {
  makeMcpDeleteTool,
  makeMcpInspectTool,
  makeMcpInstallTool,
  makeMcpListTool,
  makeMcpTestConnectionTool,
  makeMcpUpdateTool,
} from './mcp';
import {
  makePluginListTool,
  makeProposePluginInstallTool,
  makeProposePluginUninstallTool,
  makeProposeSkillInstallTool,
  makeProposeSkillInstallLocalTool,
} from './plugin';
import { makeActivatePluginTool, makeReadSkillTool } from './skillModule';
import { makeSkillManageTool } from './skillManage';
import { makeTaskTool } from './task';
import { makeCheckSubagentTasksTool } from './checkTasks';
import { makeReadBackgroundOutputTool } from './readBackgroundOutput';
import { makeAskUserChoiceTool } from './askUserChoice';
import { makeProposeDeckCreateTool } from './proposeDeck';
import { makeGenerateDeckTool } from './generateDeck';
import { makeArtifactHistoryListTool, makeArtifactHistoryCheckoutTool } from './deckHistory';
import { makeFinalizeSubmissionTool } from './finalizeSubmission';
// 本地操作工具（本期新增）—— 整体追加在现有工具数组尾部，绝不插中间（保 prompt cache，决策 6.8）
import { makeListDirTool } from './listDir';
import { makeWriteFileTool } from './writeFile';
import { makeEditFileTool } from './editFile';
import { makeGrepTool } from './grep';
import { makeGlobTool } from './glob';
import { makeManageFilesTool } from './manageFiles';
import { makeConvertCsvEncodingTool } from './convertCsvEncoding';
import { makeAppendFileTool } from './appendFile';
import { makeBashTool } from './bash';
import { makeTodoTool } from './todo';
import { makeSubmitChecklistTool } from '../../loop/submitChecklistTool';
// render_html 已迁到 capabilities/builtins/renderHtml.ts（S31·G47），此处不再 import
// render_contact_sheet / view_slide 已迁到 capabilities/builtins/deckReview.ts（任务 9），此处不再 import

/**
 * 启动期注册——index.ts 改成调这里。
 *
 * 工具到 usage 的映射（决策 7.1）：
 * - commit_changes：仅 twinMain
 * - list_projects / get_project_detail：twinMain + twinBackground
 * - record_memory / grep_memory / read_memory：twinMain + twinBackground
 *
 * escalate_to_user / ask_twin / report_progress 在段 E/F 单独注册——它们依赖 task 上下文，
 * 不能在启动期注册到 factory。这两批在 background Twin / 子 agent runner 内部即时挂上。
 */
export function registerStaticAgentTools(): void {
  // 对话期 subagent（v2）注意：twinSubagent 桶**不在**任何工具的 usages 数组里——
  // factory.ts injectTools 内部硬约束让 twinSubagent 透明继承 twinMain 工具集（除 Task）。
  // 新工具只要注册到 twinMain 就自动给 subagent 看见，不需要单独追加 'twinSubagent'。
  const TWIN_MAIN: LlmUsage[] = ['twinMain'];
  const TWIN_BOTH: LlmUsage[] = ['twinMain', 'twinBackground'];
  const TWIN_BG: LlmUsage[] = ['twinBackground'];
  const SUB_AGENT: LlmUsage[] = ['subagentCoder'];
  // web_search/web_fetch/render_html 均已迁成声明式能力（webSearchCapability / renderHtmlCapability），
  // 改由 registerBuiltinCapabilities 的 makeTools 注入（单源、防双注册），此处不再有 WEB 桶。
  // 文件工具含 subagentCoder：所有后端（含 ClaudeCodeBackend）都从这组注册拿文件能力——
  // SDK 内置 Write/Edit 已禁（S02 写入路径收口），写必经 mcp__oru__ 守卫链，不再按 backend 裁剪。
  // loopReviewer 不在内：Loop v3 审查员走 runOneShot（无工具）读对话记录盲判，不入任何工具桶
  //（2026-07-24 反转 2026-07-13「审查员带只读工具」，见 loop/reviewer.ts 头注）。
  const FILE_READ: LlmUsage[] = ['twinMain', 'twinBackground', 'subagentCoder']; // 只读
  const FILE_WRITE: LlmUsage[] = ['twinMain', 'subagentCoder']; // 写类，主桶 + 子 agent

  registerTool(makeCommitChangesTool(), TWIN_MAIN);
  registerTool(makeListProjectsTool(), TWIN_BOTH);
  registerTool(makeGetProjectDetailTool(), TWIN_BOTH);
  registerTool(makeEscalateToUserTool(), TWIN_BG);
  // ask_twin：subagentCoder（后台派工）+ twinMain。挂 twinMain 是为了让对话期 subagent（复用主
  // 对话 backend、只能减工具）经透明继承拿到它（G72）；主对话回合把 ask_twin 加进 disallowedTools
  // 屏蔽——主 agent 不该反问自己。与 Task 恰好相反（Task 主见、subagent 屏蔽），对称。
  registerTool(makeAskTwinTool(), ['twinMain', 'subagentCoder']);
  registerTool(makeReportProgressTool(), SUB_AGENT);
  // v0.4：read_file 给 Twin 读 .tool-cache/ 落盘文件 + agent 沙盒 + 项目目录
  // 追加 subagentCoder：非 anthropic 子 agent 靠此拿文件读能力（ClaudeCodeBackend 路径会被 factory 过滤掉）
  registerTool(makeReadFileTool(), FILE_READ);
  // v0.5：MCP server 反射工具不在启动期注册——由 mcp/registry.ts 在 server connected 后动态注册

  // 任务工具
  registerTool(makeListTasksTool(), TWIN_MAIN);
  registerTool(makeCreateTaskTool(), TWIN_MAIN);
  registerTool(makeUpdateTaskTool(), TWIN_MAIN);
  registerTool(makeDeleteTaskTool(), TWIN_MAIN);
  registerTool(makeRestoreTaskTool(), TWIN_MAIN);

  // 记忆工具的 usage 分桶：
  // - grep / read / query（只读）+ write_memory / edit_memory（档案读改写）：dream 复盘也要，
  //   给 [...TWIN_BOTH, 'memoryDream']。dream 升格长期档案就用这套主对话同款文档工具——
  //   一个文档模型、一套工具，沙箱(ensureWithinRoot)取代旧 upgrade_memory 的 op 白名单隔离。
  // - record_memory（建 episode）：仍主对话专属，不给 dream（dream 整理已有 episode 走自己的
  //   merge / correct / retire 结构化工具，不新建）。
  const DREAM_MEMORY_NAMES = new Set([
    'grep_memory',
    'read_memory',
    'query_episodes',
    'write_memory',
    'edit_memory',
  ]);
  for (const t of createMemoryTools()) {
    registerTool(t, DREAM_MEMORY_NAMES.has(t.name) ? [...TWIN_BOTH, 'memoryDream'] : TWIN_BOTH);
  }
  // dream 复盘 agent 专属工具（read_conversation + merge_episodes）仍走 memoryCurationCapability
  // （audience=memoryDream，S31·G47），此处不注册（防双注册）。
  // correct/retire_episode 对话侧开放（S35·G102）：注册到 [twinMain, memoryDream]——用户当场纠正
  // 即时生效，夜间整理同一套工具；twinSubagent 经 factory 透明继承。origin 各工具按 ctx.usage 推导。
  for (const t of createEpisodeCorrectionTools()) {
    registerTool(t, [...TWIN_MAIN, 'memoryDream']);
  }

  // v0.6：MCP 自装能力
  registerTool(makeMcpListTool(), TWIN_BOTH);
  registerTool(makeMcpInspectTool(), TWIN_BOTH);
  registerTool(makeMcpTestConnectionTool(), TWIN_BOTH);
  registerTool(makeMcpInstallTool(), TWIN_MAIN);
  registerTool(makeMcpUpdateTool(), TWIN_MAIN);
  registerTool(makeMcpDeleteTool(), TWIN_MAIN);

  // Skill 模块 v1
  registerTool(makePluginListTool(), TWIN_BOTH);
  registerTool(makeProposePluginInstallTool(), TWIN_MAIN);
  registerTool(makeProposePluginUninstallTool(), TWIN_MAIN);
  registerTool(makeProposeSkillInstallTool(), TWIN_MAIN);
  registerTool(makeActivatePluginTool(), TWIN_MAIN);
  registerTool(makeReadSkillTool(), TWIN_MAIN);
  registerTool(makeSkillManageTool(), TWIN_MAIN);

  // 对话期 Subagent（v2）：Task 工具注册到 twinMain；factory.injectTools 内部
  // 二次过滤把 Task 从 twinSubagent 桶剔除 → 嵌套保护
  registerTool(makeTaskTool(), TWIN_MAIN);

  // Deck 模块 v1：仅 twinMain（版本切换是用户级决策；subagent 透明继承拿到 propose_deck_create 但拿不到 task 嵌套）
  registerTool(makeProposeDeckCreateTool(), TWIN_MAIN);
  registerTool(makeArtifactHistoryListTool(), TWIN_MAIN);
  registerTool(makeArtifactHistoryCheckoutTool(), TWIN_MAIN);
  // 收尾工具：注册到 twinMain，subagent 透明继承（凡持有制品编辑上下文者都能调）
  registerTool(makeFinalizeSubmissionTool(), TWIN_MAIN);

  // ─── 本地操作工具（本期新增，决策 6.8）────────────────────────────────
  // 整体追加在现有工具之后，绝不插在中间——工具列表是 system prompt 的一部分，
  // 中间插入会让其后全部 token 错位、击穿 prompt cache。
  // 只读类（list_dir/grep/glob）+ read_file 走 FILE_READ 桶、写类（write/edit/manage）走
  // FILE_WRITE 桶，所有 backend（含 ClaudeCodeBackend）一律注入——S02 收口后写必经守卫链。
  registerTool(makeListDirTool(), FILE_READ);
  registerTool(makeGrepTool(), FILE_READ);
  registerTool(makeGlobTool(), FILE_READ);
  registerTool(makeWriteFileTool(), FILE_WRITE);
  registerTool(makeEditFileTool(), FILE_WRITE);
  registerTool(makeManageFilesTool(), FILE_WRITE);
  // todo（计划清单，S32·G49）：**只注册到 twinMain**——清单是主 Oru 的账本，不允许出现第二本账。
  // subagent 干完把结果交回来，由主 Oru 判断要不要动清单、动哪一项（它才掌握这段活在整盘计划里的
  // 位置，subagent 不知道自己对应第几项）。twinSubagent / asideComment / scheduledRun 三个透明继承
  // twinMain 的桶在 factory 层显式剔除。追加在末尾保 prompt cache。
  registerTool(makeTodoTool(), ['twinMain']);

  // bash：注册到 twinMain + subagentCoder（后台编码 subagent 接命令能力，只读重构 PRD B 块）。
  // 运行时授权门靠持久 grants 清单（isGranted）在 emit 层拦，不靠不注册（否则模型看不见 bash 永不触发首次授权，决策 6.8；enableBash 字段 S24 已停用）。
  // twinSubagent 经 factory 透明继承 twinMain 桶、保留 bash（G78/G48：对话期 subagent 下放命令权杖，
  // 副作用工具审批卡回流主对话）；只 asideComment 在 factory 层剔除 bash。subagentCoder 走通用注入循环。
  registerTool(makeBashTool(), ['twinMain', 'subagentCoder']);

  // render_html 已迁成 renderHtmlCapability（audience twinMain+twinBackground+subagentCoder，S31·G47）——
  // 由 registerBuiltinCapabilities 一处声明注入，此处不再手工对齐 usage 桶（消除"凑出来、会漏"的对齐税）。

  // ─── Deck 事后生成（创建流改造）───────────────────────────────────────
  // generate_deck：propose_deck_create 走"先过目文稿"路径建壳后，用户改完文稿触发正式生成。
  // 与 propose_deck_create 同 audience（twinMain；subagent 透明继承）。追加在末尾保 prompt cache。
  registerTool(makeGenerateDeckTool(), TWIN_MAIN);

  // ─── Deck 视觉反馈回路（任务 6 → 任务 9 迁声明式）──────────────────────
  // render_contact_sheet / view_slide 已迁成 deckReviewCapability（audience twinMain+subagentCoder，
  // 见 capabilities/builtins/deckReview.ts + registerBuiltinCapabilities）——一处声明覆盖两类受众，
  // 主对话 AI（twinMain）改标注时也能睁眼看图。此处不再手工注册到 SUB_AGENT 桶（避免双注册）。

  // ─── 带选项提问（ask_user_choice）─────────────────────────────────────
  // 仅 twinMain：subagent 透明继承到工具，但其 ToolContext 不挂 askUserChoice → execute 优雅 isError
  //（本期只做主对话，PRD 明确不扩到 subagent 线）。追加在末尾保 prompt cache。
  registerTool(makeAskUserChoiceTool(), TWIN_MAIN);

  // ─── 后台任务现查（check_subagent_progress）──────────────────────────
  // 仅 twinMain：主对话 AI 在回合进行中现查 propose_action 派出的后台编码 task 状态/进度，
  // 补「在场干等问进度」缺口（与回合起点 hint、终态主动播报构成三条可见性通道）。
  // store 能力经 agent/tasksGateway 启动期注入。追加在末尾保 prompt cache。
  registerTool(makeCheckSubagentTasksTool(), TWIN_MAIN);

  // ─── 后台命令输出现读（read_background_output · S19·G16）─────────────
  // 与 bash 同桶（twinMain + subagentCoder）：谁能起后台命令，谁就能按编号读回它的累积输出。
  // 追加在末尾保 prompt cache。
  registerTool(makeReadBackgroundOutputTool(), ['twinMain', 'subagentCoder']);

  // ─── 本地文件夹装 skill（propose_skill_install_local）──────────────────
  // 与 propose_skill_install（GitHub 版）同 audience（twinMain）。补齐"用户给本地路径/下载好的
  // skill 文件夹"这条一等公民安装路径，堵住 Oru 退化为 bash cp 绕过热注册的老路。
  // 追加在末尾保 prompt cache。
  registerTool(makeProposeSkillInstallLocalTool(), TWIN_MAIN);

  // ─── 表格编码转换（convert_csv_encoding）───────────────────────────────
  // 与写类文件工具同桶（FILE_WRITE）：它是出口闸门「这张表不是 UTF-8」那条拦截的唯一出路，
  // 谁会撞上那道闸（写文件 / 跑脚本），谁就得能走这条路。追加在末尾保 prompt cache。
  registerTool(makeConvertCsvEncodingTool(), FILE_WRITE);

  // ─── 追加写（append_file）──────────────────────────────────────────────
  // 与写类文件工具同桶。补的是"往表尾加一行"这个此前没有原语的动作——让正确的路同时是最省的路，
  // 模型不必再为加一行绕去 bash + python（那条路不过表格定型）。追加在末尾保 prompt cache。
  registerTool(makeAppendFileTool(), FILE_WRITE);

  // ─── Loop 拆解提交（submit_checklist）─────────────────────────────────
  // 仅 loopCompile 桶：拆解受限回合唯一的工具（回合侧还有 restrictToolsTo 白名单双保险）。
  // 不进 twinMain——主对话看不见它，不存在被继承桶捎走的问题。
  registerTool(makeSubmitChecklistTool(), ['loopCompile']);
}
