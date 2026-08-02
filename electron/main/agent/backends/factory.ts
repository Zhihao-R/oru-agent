/**
 * Backend factory — 业务代码唯一获取 AgentBackend 的入口
 *
 * 职责：
 * 1. 持有 AgentTool 注册表（含每个工具允许的 usage 白名单），按 usage 过滤注入
 * 2. 按用户在 settings 配置的 modelAssignments 路由到具体 backend 类
 * 3. 每次 getBackendFor 都新建实例（避免 settings 改了仍用旧的）
 *
 * 段 A 范围：只实现 ClaudeCodeBackend 路径（含老用户 OAuth fallback）。
 * 非 anthropic 类型的 provider 抛 not-implemented，由段 B/D 接入。
 */
import type { AgentBackend, AgentTool } from '@shared/agent/backend';
import type { LlmUsage, RegisteredModel, BackendProvider } from '@shared/types';
import { ErrorCodes } from '@shared/types';
import {
  LOCAL_CLAUDE_HEAVY,
  LOCAL_CLAUDE_LIGHT,
  parseLocalClaudeAssignment,
} from '@shared/agent/localClaudeModels';
import { getSettings } from '../../projects/store';
import { resolveSubprocessEnv } from '../auth';
import { AnthropicBackend } from './anthropic';
import { ClaudeCodeBackend } from './claudeCode';
import { OpenAICompatibleBackend, resolveOpenAICompatibleBaseURL } from './openaiCompatible';
import { providerProtocol } from '@shared/agent/providerProtocol';
import { resolveAnthropicCompatiblePreset } from './providerPresets';
import { getCapabilitiesForUsage } from '../capabilities/registry';
import { meterBackend } from './meterBackend';

type ToolEntry = { tool: AgentTool; usages: LlmUsage[] };

const toolRegistry = new Map<string, ToolEntry>();

/**
 * 注册一个工具，限定它对哪些 usage 可见。
 * 例：propose_action 只给 twinMain；escalate_to_user 只给 twinBackground。
 *
 * v0.5：支持运行时调用——动态注册由 mcp/registry.ts 使用。
 * 下一次 getBackendFor() 创建的 backend 实例会拿到注册表最新快照。
 */
export function registerTool(tool: AgentTool, usages: LlmUsage[]): void {
  toolRegistry.set(tool.name, { tool, usages });
}

/**
 * 注销一个工具（v0.5）——用于外部 MCP server 停止时把它反射的 AgentTool 摘掉。
 * 已存活的 backend 实例不会反向感知到工具消失，但下次 getBackendFor() 时新 backend
 * 自然不会再注入该工具——跟 register 的语义对称。
 */
export function unregisterTool(name: string): void {
  toolRegistry.delete(name);
}

/** 仅测试用：清空注册表 */
export function __clearToolRegistryForTest(): void {
  toolRegistry.clear();
}

/**
 * 列出注册表里全部工具名（含外部 MCP 反射工具——它们也在同一张表里，枚举即超集）。
 * 用途：随手评点（aside）只读白名单回合的兜底 denylist——三 backend 已原生消费
 * restrictToolsTo 做正向交集，chat 管线侧再用"注册表全量 − 白名单"算 denylist 做第二层保险，
 * 这里只提供枚举。
 */
export function listRegisteredToolNames(): string[] {
  return Array.from(toolRegistry.keys());
}

/** 仅测试用：列出已注册的工具（含 usages） */
export function __listRegisteredToolsForTest(): ToolEntry[] {
  return Array.from(toolRegistry.values());
}

/**
 * 按名称取已注册的工具实例——供 stream.ts 查 tool.persistPolicy / persistExt（v0.4 源头落盘）。
 * 找不到返回 undefined——shouldPersist 把它当作 persistPolicy='auto' 处理。
 */
export function getToolByName(name: string): AgentTool | undefined {
  return toolRegistry.get(name)?.tool;
}

// ─── factory 主入口 ──────────────────────────────────────────

type FactoryFn = (usage: LlmUsage) => Promise<AgentBackend>;

let factoryFn: FactoryFn = realGetBackendFor;

/**
 * 业务代码用这个。
 * 抛 AGENT_NO_AUTH 时调用方应给前端导引用户去 Settings 配置。
 *
 * 返回的实例外裹一层用量计量代理（meterBackend）：每次模型调用的 result.usage 按 usage 落到
 * 用量账本（S13 · G110）。计量收在这唯一入口，故三后端与所有调用点自动一致、零对齐税。
 */
export function getBackendFor(usage: LlmUsage): Promise<AgentBackend> {
  return factoryFn(usage).then((backend) => meterBackend(backend, usage));
}

/** 仅测试用：替换全局 factory（mock） */
export function __setBackendFactoryForTest(fn: FactoryFn): () => void {
  const prev = factoryFn;
  factoryFn = fn;
  return () => {
    factoryFn = prev;
  };
}

/**
 * 派工探针：后台编码 subagent 此刻是否可用。
 *
 * 单一判据——proposeAction 的派工前置自检与 runTask 入口（兜底）共用 getBackendFor('subagentCoder')
 * 的同一套路由，鉴权口径不会两处漂移。可用性交给 isReady()（缺 key 返回 ok:false + hint）。
 * getBackendFor 仅在 backend 构造阶段失败时才 throw（如 custom-openai 缺 baseUrl），故此处
 * try-catch 兜住这类构造异常，与 isReady 的 ok:false 一起统一收敛成 { ok, hint }。
 */
export async function subagentCoderReady(): Promise<{ ok: boolean; hint?: string }> {
  try {
    const backend = await getBackendFor('subagentCoder');
    return await backend.isReady();
  } catch (e) {
    return { ok: false, hint: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * OAuth fallback（复用本机 Claude 登录态、未显式配置 provider）时的默认模型。
 * 这条路走 ClaudeCodeBackend → Claude Agent SDK，吃订阅额度而非按 API token 计费；
 * 显式锁定模型不让 SDK 自挑默认。未来设置 UI 暴露「本机登录 + 选模型」后，这里就是那个选择器的默认值。
 *
 * 分两档：回落模型跟随 usage 的「重量级」，不再一律 opus——身份/干活/重活档用 opus，廉价背景档用 haiku。
 * 廉价档是本次症状的解药：memoryRecall（每轮串联跑的能力/记忆挑选器）裹 inject.ts 的 4s 超时，opus
 * 子进程冷启动 + 全量推理跑不进这 4s，每轮被 ctl.abort() 掐（表现为「Claude Code process aborted by
 * user」，其实是自家超时闹钟）。loopReviewer / conversationTitle 不受 4s 死线之苦（各自 120s / 30s
 * 超时，跑得完），归轻量档纯因它们本就是廉价任务、犯不上 opus。
 *
 * 排除侧同样是刻意的：conversationSummary（远端实测 ~46s 的重活，compress.ts 给 90s）、memoryDream
 * 需要大模型的质量，留 opus 档——别顺手把它们塞进下面的集合。
 */
// 「本机 Claude 模型名」单源见 @shared/agent/localClaudeModels（显式下拉与这里的回落共用一份）。
const OAUTH_FALLBACK_MODEL = LOCAL_CLAUDE_HEAVY;
const OAUTH_FALLBACK_LIGHT_MODEL = LOCAL_CLAUDE_LIGHT;

/**
 * 未分配模型时走 OAuth 轻量档的廉价背景用途；其余（身份/干活/重活）走 opus 档。加第二个轻量用途只往里加一条。
 * memoryRecall / loopReviewer 的「该走轻量」在 shared/types.ts 的 LLM_USAGES 定义处已用自然语言声明——
 * 改那边的重量级判断要同步核这个集合（两处声明，暂无结构化单源；用途多到值得时再抽 usage.weight）。
 */
const LIGHT_FALLBACK_USAGES = new Set<LlmUsage>(['memoryRecall', 'loopReviewer', 'conversationTitle']);

/**
 * 构造 ClaudeCodeBackend——先解析 SDK 子进程 env 注入构造器（原散在 7 个调用方，M4 收口进构造期）。
 * factory 是全系统构造 backend 的唯一入口，故 env 解析收在这里，三处 ClaudeCodeBackend 落点共用。
 */
async function buildClaudeCodeBackend(
  model: string | undefined,
  opts: { modelId?: string; providerId?: string; supportsVision?: boolean },
): Promise<ClaudeCodeBackend> {
  return new ClaudeCodeBackend(model, { ...opts, env: await resolveSubprocessEnv() });
}

/** OAuth fallback：按 usage 重量级挑回落模型，构造 ClaudeCodeBackend 并注入工具。三处回落落点共用。 */
async function oauthFallback(usage: LlmUsage): Promise<AgentBackend> {
  const model = LIGHT_FALLBACK_USAGES.has(usage) ? OAUTH_FALLBACK_LIGHT_MODEL : OAUTH_FALLBACK_MODEL;
  return injectTools(
    await buildClaudeCodeBackend(model, { supportsVision: OAUTH_FALLBACK_SUPPORTS_VISION }),
    usage,
  );
}
/**
 * OAuth fallback 模型是否支持视觉——两档模型（opus 4.8 / haiku 4.5）均支持视觉，故对轻/重档共用。
 * 单一事实源：factory 自身的 fallback 注入与 router 的兜底校验都引用它，换 fallback 模型时只改这一处。
 * （前端 ChatArea 跨进程拿不到此常量，另有一份带注释的镜像默认值。）
 */
export const OAUTH_FALLBACK_SUPPORTS_VISION = true;

async function realGetBackendFor(usage: LlmUsage): Promise<AgentBackend> {
  // 对话期 Subagent（v2）：跟主对话同 backend / model（PRD §模型选择决策）；
  // 透传 'twinMain' 进入下面的真实分配查询，保证 cache 命中可预测。
  // settings UI 不暴露 twinSubagent 选项——用户不该单独配 subagent 模型。
  const effectiveUsage: LlmUsage = usage === 'twinSubagent' ? 'twinMain' : usage;
  const settings = await getSettings();
  let assignedModelId = settings.modelAssignments[effectiveUsage];

  // 随手评点（aside）短评：未分配时回落 twinMain 的路由——短评必须是"这个 Oru"说的
  // （技术方案 §5.2）。与 twinSubagent 的无条件映射不同：asideComment 在设置 UI 有
  // 独立选项，用户显式分配了模型就尊重分配，只在 null/缺失时回落。
  // twinMain 自己也未分配时保持 null，下面统一走 OAuth fallback——与 twinMain 同路。
  // 定时任务执行体（S18）同口径回落 twinMain——执行体必须是「这个 Oru」（§4）。设置 UI 有独立
  // 选项，显式分配则尊重，只在 null/缺失时回落。
  // Loop 拆解（loopCompile）同口径——拆解是「这个 Oru」理解用户意图的活。
  if (
    !assignedModelId &&
    (effectiveUsage === 'asideComment' || effectiveUsage === 'scheduledRun' || effectiveUsage === 'loopCompile')
  ) {
    assignedModelId = settings.modelAssignments.twinMain;
  }

  // 没分配：尝试 OAuth fallback → 默认 ClaudeCodeBackend，回落模型按 usage 重量级分档
  if (!assignedModelId) {
    return oauthFallback(usage);
  }

  // 显式指定本机 Claude 模型（sentinel `local:<sdkModel>`）→ ClaudeCodeBackend，跳过注册表查询。
  // 与 null 分配的 oauthFallback（按重量级自动挑档）并列：这里是用户点名了具体档位。三款均支持视觉。
  const localModel = parseLocalClaudeAssignment(assignedModelId);
  if (localModel) {
    return injectTools(await buildClaudeCodeBackend(localModel, { supportsVision: true }), usage);
  }

  const model = settings.models.find((m) => m.id === assignedModelId);
  if (!model) {
    // settings 不一致（model 被删但 assignment 残留）—— 退回 fallback
    return oauthFallback(usage);
  }
  const provider = settings.providers.find((p) => p.id === model.providerId);
  if (!provider) {
    return oauthFallback(usage);
  }

  // subagentCoder 有专属路由（anthropic → ClaudeCodeBackend；非 anthropic → 通用 backend），
  // 与「按 model+provider 构造普通 backend」正交，留在本函数；其余共用 helper。
  if (usage === 'subagentCoder') {
    if (provider.type === 'anthropic') {
      // anthropic subagentCoder 走 ClaudeCodeBackend；文件写能力与所有路径同源——
      // mcp__oru__ 守卫链工具（SDK Write/Edit 已在 DEFAULT_DENIED_BUILTINS，S02 收口）。
      // apiKey 沿用 detectAuth（OAuth → env → manualApiKey），不从 settings.providers 取。
      return injectTools(
        await buildClaudeCodeBackend(model.modelId, {
          modelId: model.id,
          providerId: provider.id,
          supportsVision: model.supportsVision ?? false,
        }),
        usage,
      );
    }
    // 非 anthropic subagentCoder → 通用 backend 构造（OpenAICompatibleBackend 等），
    // 文件工具与其他 usage 一样按注册桶注入。
    return injectTools(buildBackendFromModelProvider(model, provider), usage);
  }

  return injectTools(buildBackendFromModelProvider(model, provider), usage);
}

/**
 * 按 model + provider 构造普通 backend（不注入工具）——realGetBackendFor 和 getBackendForModel 共用。
 *
 * 「普通」= 排除 usage 专属路由：subagentCoder 的 ClaudeCodeBackend / OAuth fallback 不走这里。
 * 关键：anthropic 直连 / OpenAI 兼容两条分支都带上 modelId: model.id / providerId: provider.id——
 * 流式对话（runner.ts）与中断恢复（interrupted.ts）依赖这俩字段溯源到 settings 注册项，绝不能漏。
 */
function buildBackendFromModelProvider(
  model: RegisteredModel,
  provider: BackendProvider,
): AgentBackend {
  // 按线上协议二分（providerProtocol），不再按 type 枚举——加第三方 coding plan 是加数据不是改结构。
  if (providerProtocol(provider.type) === 'anthropic-native') {
    // anthropic 直连 + 三家 coding plan：统一走 AnthropicBackend，端点与鉴权模式由预设解析。
    let preset: { baseUrl?: string; authMode: 'x-api-key' | 'bearer' };
    try {
      preset = resolveAnthropicCompatiblePreset(provider.type, provider.baseUrl);
    } catch (e) {
      const err = new Error((e as Error).message) as Error & { code?: string };
      err.code = ErrorCodes.AGENT_NO_AUTH;
      throw err;
    }
    const useBearer = preset.authMode === 'bearer';
    return new AnthropicBackend({
      // Bearer 厂商凭证走 authToken，apiKey 留空；x-api-key 反之——clientAuth 二选一发。
      apiKey: useBearer ? '' : provider.apiKey,
      authToken: useBearer ? provider.apiKey : undefined,
      defaultModel: model.modelId,
      baseURL: preset.baseUrl,
      modelId: model.id,
      providerId: provider.id,
      maxOutputTokens: model.maxOutputTokens,
      supportsPromptCache: model.supportsPromptCache,
      supportsVision: model.supportsVision,
    });
  }

  // openai-fc：openrouter / openai / zhipu / kimi / custom-openai
  let baseURL: string;
  try {
    baseURL = resolveOpenAICompatibleBaseURL(provider.type, provider.baseUrl);
  } catch (e) {
    const err = new Error((e as Error).message) as Error & { code?: string };
    err.code = ErrorCodes.AGENT_NO_AUTH;
    throw err;
  }
  return new OpenAICompatibleBackend({
    apiKey: provider.apiKey,
    defaultModel: model.modelId,
    baseURL,
    providerType: provider.type,
    modelId: model.id,
    providerId: provider.id,
    maxOutputTokens: model.maxOutputTokens,
    supportsVision: model.supportsVision,
    supportsPromptCache: model.supportsPromptCache,
    supportsReasoning: model.supportsReasoning,
    reasoningEffort: model.reasoningEffort,
  });
}

/**
 * 调试台用：按任选的 RegisteredModel.id 构造一个 backend，跑一次性 completion。
 * 不经 modelAssignments、不注入工具——纯模型直连，与对话路由解耦。
 */
export async function getBackendForModel(modelId: string): Promise<AgentBackend> {
  const settings = await getSettings();
  const model = settings.models.find((m) => m.id === modelId);
  if (!model) throw new Error(`未知模型：${modelId}`);
  const provider = settings.providers.find((p) => p.id === model.providerId);
  if (!provider) throw new Error(`模型 ${modelId} 的 provider 不存在：${model.providerId}`);
  return buildBackendFromModelProvider(model, provider);
}

/**
 * 只给主 Oru 的工具——**所有**透明继承 twinMain 的桶（twinSubagent / asideComment / scheduledRun）
 * 一律剔除。一句规则一处判据：新增继承桶时不会静默把它们继承走。
 *
 * todo（计划清单）：清单是主 Oru 的账本，subagent 干完交回结果、由主 Oru 判断动哪一项——它不知道
 * 自己对应第几项，让它记就是第二本账。定时执行体则是只写不读（一次性 conversationId、不挂
 * onTodoUpdate、不走 buildRuntimeContext 与 runChatAndPersist），落盘后更是永久孤儿文件。
 */
const MAIN_ONLY_TOOLS = new Set(['todo']);

/**
 * 把注册表里允许该 usage 的工具全部注入到 backend 实例。
 *
 * 对话期 Subagent（v2）特殊规则：`twinSubagent` 桶 = `twinMain` 桶 - `Task`。
 * 在 factory 层硬约束，让"subagent 跟主 agent 工具完全一致"成为系统不变量——
 * 新工具只要注册到 twinMain 就自动给 subagent 看见，不需要每个 registerTool 调用
 * 单独追加 'twinSubagent'。这样未来加工具不会忘记给 subagent。
 *
 * Task 工具的嵌套保护：注册时只挂 twinMain；以下 if 还会把它从 twinSubagent 桶过滤掉
 * 作为第二层保护（双层防御：单点漏掉一处仍然安全）。
 */
function injectTools(backend: AgentBackend, usage: LlmUsage): AgentBackend {
  // 声明式能力 · 阶段一（backend 供给）：在同步注入循环**之前**放行命中能力的 oru 工具。
  // 循环走到 web_search 时 backend 的 ignored 判断已为 false，工具正常进 this.tools——
  // 无需补注册，时序由"先 allow 后 inject"保证（技术设计 §2.3）。
  applyBackendCapabilitySupply(backend, usage);
  // twinSubagent / asideComment 透明继承 twinMain 工具集，各有一处固定裁剪：
  //   twinSubagent = twinMain − Task（G78/G48：任意命令 bash 保留下放——subagent 执行的
  //     每个操作再逐个过闸，副作用工具的审批卡回流主对话标「来自 subagent」，回流设施已就绪）。
  //   asideComment = twinMain − Task − bash（二期 §3：短评「能看能查」，只读短聊不给命令权杖）。
  // Task 恒剔除是嵌套保护（分身不能分身，P1 定案 2026-08-02），两桶同口径；bash 只对 asideComment 剔除。
  // 委派工具收敛后 `Task` 是全仓唯一委派工具（propose_action 已退役），sync/async 都经它。
  // 两个 subagent 运行时都无法再派下级：
  //   twinSubagent（sync 对话期）工具集剔 Task → 无委派工具；其 ToolContext 亦不挂 runSubagent。
  //   subagentCoder（async 后台）的 usages 数组本就没有 Task / propose_action → 天然无法再派。
  // 故「分身不能分身」在两条运行时都成立，无递归、绝对安全。
  // 加新「派下级」工具时按此判据定剔留（它派出的是叶子还是同构体），别默认继承。
  // 白名单 restrictToolsTo（aside 只读回合）仍是第二道保险，工厂层这层是显式主约束。
  //   主 Oru 专属工具（MAIN_ONLY_TOOLS）在三个继承桶里统一剔除，见该集合注释。
  if (usage === 'twinSubagent' || usage === 'asideComment') {
    for (const entry of toolRegistry.values()) {
      if (!entry.usages.includes('twinMain')) continue;
      if (entry.tool.name === 'Task' || MAIN_ONLY_TOOLS.has(entry.tool.name)) continue;
      if (entry.tool.name === 'bash' && usage === 'asideComment') continue;
      backend.registerTool(entry.tool);
    }
    return backend;
  }
  // 定时任务执行体（S18·§4）：同款透明继承 twinMain 工具桶，但**不剔除 Task 与 bash**——旧路径的
  // 定时执行就是主对话回合、二者本可用，且执行体已接审批回流，剔除才是能力缩水（「与主对话回合同套」）。
  // 唯一的剔除是 MAIN_ONLY_TOOLS（见该集合注释）。
  if (usage === 'scheduledRun') {
    for (const entry of toolRegistry.values()) {
      if (MAIN_ONLY_TOOLS.has(entry.tool.name)) continue;
      if (entry.usages.includes('twinMain')) backend.registerTool(entry.tool);
    }
    return backend;
  }
  for (const entry of toolRegistry.values()) {
    if (entry.usages.includes(usage)) {
      backend.registerTool(entry.tool);
    }
  }
  return backend;
}

/**
 * 声明式能力 · 阶段一：对命中 usage 的能力应用 claudeCodeTools.allow。
 * 仅 ClaudeCodeBackend 有 ignored 名单——其它 backend（Anthropic / OpenAI 兼容）无此层，
 * claudeCodeTools 对它们天然 no-op，所以 instanceof 收窄后再调。
 */
function applyBackendCapabilitySupply(backend: AgentBackend, usage: LlmUsage): void {
  if (!(backend instanceof ClaudeCodeBackend)) return;
  const allow: string[] = [];
  for (const cap of getCapabilitiesForUsage(usage)) {
    if (cap.claudeCodeTools?.allow) allow.push(...cap.claudeCodeTools.allow);
  }
  if (allow.length > 0) backend.removeFromIgnoredTools(allow);
}
