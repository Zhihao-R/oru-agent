/**
 * 「本机 Claude 登录」可显式指定的 SDK 模型——走 OAuth 订阅额度（非 API 计费），
 * 由 ClaudeCodeBackend 透到 SDK Options.model。
 *
 * 功能分配 UI 把这三项作为可选项列进**每个**用途（统一可选范围）；modelAssignments 里
 * 存 sentinel 值 `local:<sdkModel>`，factory.realGetBackendFor 拦截它 → 直接构造
 * ClaudeCodeBackend(sdkModel)，跳过 settings.models 注册表查询。
 *
 * 与空分配并存：空分配仍是「默认」= 按 usage 重量级自动挑档（factory.oauthFallback），
 * 这里是用户点名了具体档位。三款模型均支持视觉，故构造时 supportsVision 恒 true。
 */
export const LOCAL_CLAUDE_PREFIX = 'local:';

/**
 * 本机 Claude 的 SDK 模型 id——「本机 Claude 模型名」的唯一声明源。
 * factory 的 OAuth 回落分档（未分配时按 usage 重量级挑）也从这里取（HEAVY/LIGHT），
 * 避免与显式下拉列表两处硬编码漂移。升级档位只改这里。
 */
export const LOCAL_CLAUDE_HEAVY = 'claude-opus-4-8';
export const LOCAL_CLAUDE_MID = 'claude-sonnet-4-6';
export const LOCAL_CLAUDE_LIGHT = 'claude-haiku-4-5';

/** 有序：UI 逐项列出的顺序即此数组顺序（重 → 轻）。label 是专有名词，不进 i18n。 */
export const LOCAL_CLAUDE_MODELS = [
  { sdkModel: LOCAL_CLAUDE_HEAVY, label: 'Opus 4.8' },
  { sdkModel: LOCAL_CLAUDE_MID, label: 'Sonnet 4.6' },
  { sdkModel: LOCAL_CLAUDE_LIGHT, label: 'Haiku 4.5' },
] as const;

/** 构造分配值：`local:claude-opus-4-8` 等。 */
export const localClaudeAssignment = (sdkModel: string): string => `${LOCAL_CLAUDE_PREFIX}${sdkModel}`;

/**
 * 分配值是「本机 Claude 显式模型」时返回 SDK 模型名，否则 null。
 * 白名单校验：只认 LOCAL_CLAUDE_MODELS 里的三款，脏 sentinel 当未识别（回落默认档）。
 */
export function parseLocalClaudeAssignment(assignedModelId: string | null | undefined): string | null {
  if (!assignedModelId || !assignedModelId.startsWith(LOCAL_CLAUDE_PREFIX)) return null;
  const sdkModel = assignedModelId.slice(LOCAL_CLAUDE_PREFIX.length);
  return LOCAL_CLAUDE_MODELS.some((m) => m.sdkModel === sdkModel) ? sdkModel : null;
}
