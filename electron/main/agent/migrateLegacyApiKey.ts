/**
 * 启动期老 manualApiKey → BackendProvider 迁移
 *
 * 触发条件：settings.migratedFromManualApiKey 仍为 false。
 *
 * 行为：
 * - OAuth 模式（claude_cli）：不建 provider；只设标志为 true（OAuth token 不是普通 API Key）
 * - manual_api_key / env_api_key：建一个 anthropic provider + sonnet 4.6 RegisteredModel，
 *   把四个 usage 全指向新 model
 * - 其他（none）：只设标志为 true（用户日后自己去 Settings 加）
 *
 * 幂等：标志一旦置 true，后续启动跳过；用户事后清空 / 替换 manualApiKey 不再触发自动迁移。
 *
 * 必须在 ws server start 之前完成调用，避免渲染端首次拉 settings 时看到未迁移状态。
 */
import type { BackendProvider, ClaudeAuthStatus, RegisteredModel } from '@shared/types';
import { newProviderId, newRegisteredModelId } from '@shared/ids';
import { getSettings, updateSettings } from '../projects/store';
import { detectAuth as defaultDetectAuth } from './auth';

const DEFAULT_ANTHROPIC_MODEL_ID = 'claude-sonnet-4-6';

/**
 * @param deps 可选依赖注入；smoke 测试用 mockDetectAuth 控制鉴权 mode
 */
export async function migrateLegacyApiKey(
  deps: { detectAuth?: () => Promise<ClaudeAuthStatus> } = {},
): Promise<void> {
  const detectAuth = deps.detectAuth ?? defaultDetectAuth;
  const settings = await getSettings();
  if (settings.migratedFromManualApiKey) return;

  // 没填 manualApiKey 也没 OAuth 也没 env：直接设标志，不动 providers
  const auth = await detectAuth();
  const apiKey = settings.manualApiKey?.trim();

  if (auth.mode === 'claude_cli' || auth.mode === 'none' || !apiKey) {
    await updateSettings({ migratedFromManualApiKey: true });
    return;
  }

  // env_api_key / manual_api_key：建 provider + model
  const provider: BackendProvider = {
    id: newProviderId(),
    type: 'anthropic',
    label: 'Anthropic（自动迁移）',
    apiKey,
  };
  const model: RegisteredModel = {
    id: newRegisteredModelId(),
    providerId: provider.id,
    modelId: DEFAULT_ANTHROPIC_MODEL_ID,
    label: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    supportsVision: true,
    supportsPromptCache: true,
    supportsReasoning: true,
  };
  await updateSettings({
    providers: [...settings.providers, provider],
    models: [...settings.models, model],
    modelAssignments: {
      twinMain: model.id,
      twinBackground: model.id,
      memoryDream: model.id,
      subagentCoder: model.id,
      conversationSummary: model.id,
      conversationTitle: model.id,
      // 对话期 subagent 跟随 twinMain（factory 内部 fallback；此处显式填同值更直观）
      twinSubagent: model.id,
      // 随手评点短评同上——跟随 twinMain，显式填同值
      asideComment: model.id,
      // Loop 独立审查员：迁移时也填同值（用户后续可在设置里改成更轻量的模型）
      loopReviewer: model.id,
      // 记忆召回挑选器：迁移时填同值（用户后续可改成更轻量的小模型）
      memoryRecall: model.id,
      // 定时任务执行体：迁移时填同值（未分配时本会回落 twinMain，显式填同值更直观）
      scheduledRun: model.id,
      // Loop 拆解：迁移时填同值（未分配时本会回落 twinMain，显式填同值更直观）
      loopCompile: model.id,
    },
    migratedFromManualApiKey: true,
  });
}
