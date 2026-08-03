/**
 * models.* / modelAssignments.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内各 case 字节级一致——纯搬运；validateModelInput 为本域专用本地函数随迁。
 */
import { ErrorCodes, LLM_USAGES, type RegisteredModel } from '@shared/types';
import { newRegisteredModelId } from '@shared/ids';
import type { RegistrySlice } from './types';
import { getSettings, updateSettings } from '../../projects/store';
import { broadcastMainChatStatus } from './backendStatusBroadcast';

// ─── model input validation ────────────────────────────────────────
/**
 * 校验 RegisteredModel 入参；返回中文错误说明（null = 合法）。
 * 同时用于 add / update（update 时传入 patch 合并后的完整 model）。
 *
 * 规则：
 * - contextWindow 必填且为正整数 ≥ 1024
 * - supportsVision 必填且为 boolean（不能 undefined）
 * - maxOutputTokens 若给，必须正整数且 ≤ contextWindow
 *
 * 注意：本期校验仅作用于"用户主动添加 / 修改"的 RegisteredModel；
 *       OAuth (claude_cli) 路径不创建 RegisteredModel，不会进入此校验。
 */
function validateModelInput(m: RegisteredModel): string | null {
  if (typeof m.contextWindow !== 'number' || !Number.isInteger(m.contextWindow) || m.contextWindow < 1024) {
    return '请填写上下文窗口（正整数，≥ 1024）';
  }
  if (typeof m.supportsVision !== 'boolean') {
    return '请选择是否支持视觉';
  }
  if (m.maxOutputTokens != null) {
    if (!Number.isInteger(m.maxOutputTokens) || m.maxOutputTokens <= 0) {
      return '最大输出 token 必须是正整数';
    }
    if (m.maxOutputTokens > m.contextWindow) {
      return '最大输出 token 不能超过上下文窗口';
    }
  }
  if (m.reasoningEffort != null) {
    const valid = ['minimal', 'low', 'medium', 'high', 'xhigh'];
    if (!valid.includes(m.reasoningEffort)) {
      return `思考强度必须是 ${valid.join(' / ')} 之一`;
    }
  }
  return null;
}

export const modelHandlers = {
  'models.list': async (req, { reply }) => {
    const settings = await getSettings();
    reply(req.reqId, { type: 'models.state', models: settings.models });
  },
  'models.add': async (req, { reply, broadcast }) => {
    const cur = await getSettings();
    const candidate = { id: newRegisteredModelId(), ...req.model } as RegisteredModel;
    const invalid = validateModelInput(candidate);
    if (invalid) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.MODEL_INVALID, message: invalid });
      return;
    }
    const updated = await updateSettings({ models: [...cur.models, candidate] });
    reply(req.reqId, { type: 'models.state', models: updated.models });
    broadcast({ type: 'models.state', models: updated.models });
    await broadcastMainChatStatus(broadcast);
  },
  'models.update': async (req, { reply, broadcast }) => {
    const cur = await getSettings();
    const idx = cur.models.findIndex((m) => m.id === req.id);
    if (idx < 0) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.MODEL_NOT_FOUND,
        message: `model ${req.id} 不存在`,
      });
      return;
    }
    // 白名单：只允许 patch 中类型协议里的字段（modelId / providerId 不能改）
    const merged: RegisteredModel = { ...cur.models[idx], ...req.patch };
    const invalid = validateModelInput(merged);
    if (invalid) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.MODEL_INVALID, message: invalid });
      return;
    }
    const next = [...cur.models];
    next[idx] = merged;
    const updated = await updateSettings({ models: next });
    reply(req.reqId, { type: 'models.state', models: updated.models });
    broadcast({ type: 'models.state', models: updated.models });
    await broadcastMainChatStatus(broadcast);
  },
  'models.remove': async (req, { reply, broadcast }) => {
    const cur = await getSettings();
    const filtered = cur.models.filter((m) => m.id !== req.id);
    // 清理引用了该 model 的 assignments
    const cleanedAssignments = { ...cur.modelAssignments };
    for (const usage of Object.keys(cleanedAssignments) as Array<keyof typeof cleanedAssignments>) {
      if (cleanedAssignments[usage] === req.id) {
        cleanedAssignments[usage] = null;
      }
    }
    const updated = await updateSettings({
      models: filtered,
      modelAssignments: cleanedAssignments,
    });
    reply(req.reqId, { type: 'models.state', models: updated.models });
    broadcast({ type: 'models.state', models: updated.models });
    broadcast({ type: 'modelAssignments.state', assignments: updated.modelAssignments });
    await broadcastMainChatStatus(broadcast);
  },
  'modelAssignments.update': async (req, { reply, broadcast }) => {
    // 校验 usage 是已知枚举——否则脏 key 会被写进 settings.modelAssignments
    if (!LLM_USAGES.includes(req.usage as (typeof LLM_USAGES)[number])) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.MODEL_INVALID,
        message: `未知的 model usage：${String(req.usage)}`,
      });
      return;
    }
    // modelId 内容不在此校验（与「注册 model 被删后 assignment 残留」同策略）：读侧统一兜底——
    // 未知注册 id / 非白名单 local: sentinel 都在 factory 回落到 OAuth 默认档，不会写脏就崩。
    const cur = await getSettings();
    const next = { ...cur.modelAssignments, [req.usage]: req.modelId };
    const updated = await updateSettings({ modelAssignments: next });
    reply(req.reqId, { type: 'modelAssignments.state', assignments: updated.modelAssignments });
    broadcast({ type: 'modelAssignments.state', assignments: updated.modelAssignments });
    await broadcastMainChatStatus(broadcast);
  },
  'modelThinking.update': async (req, { reply, broadcast }) => {
    // 校验 usage 是已知枚举——否则脏 key 会被写进 settings.modelThinking
    if (!LLM_USAGES.includes(req.usage as (typeof LLM_USAGES)[number])) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.MODEL_INVALID,
        message: `未知的 model usage：${String(req.usage)}`,
      });
      return;
    }
    const cur = await getSettings();
    const next = { ...cur.modelThinking, [req.usage]: req.thinking };
    const updated = await updateSettings({ modelThinking: next });
    // 思考与分配模型无关、不影响主对话后端可用性，不需要 broadcastMainChatStatus。
    // 用 settings.state 回写（与 settings.update 同口径）——渲染层 syncSettings 统一消费。
    reply(req.reqId, { type: 'settings.state', settings: updated });
    broadcast({ type: 'settings.state', settings: updated });
  },
} satisfies RegistrySlice;
