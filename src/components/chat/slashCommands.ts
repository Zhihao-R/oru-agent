/**
 * 桌面斜杠命令调度层（斜杠命令补全 plan §4）——ChatArea.onSend 先过 parseCommand，
 * 命中交这里执行（不进 chatStore.send）；未命中原样发送。与平台端同一套解析器、同一套
 * 命令面（含 /status——PM 2026-08-01 拍板两端同体验，状态快照数据源全在渲染层 store）。
 *
 * 本层可单测：store / ws 调用全部经 SlashDeps 注入，i18n 经 t 注入；
 * desktopSlashDeps 是生产接线（收在一处，不散进组件）。
 */
import type { TFunction } from 'i18next';
import type { PlatformCommand } from '@shared/platform/message';
import type {
  ConvCompressResultEvent,
  ModelAssignmentsStateEvent,
  ModelsStateEvent,
  SettingsStateEvent,
} from '@shared/protocol';
import type { ApprovalMode, Conversation, RegisteredModel } from '@shared/types';
import { DEFAULT_NEW_CONV_TITLE } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';

/** 命令面板内容（/help、无参 /model、执行反馈复用同一面板）。 */
export type SlashPanelState =
  | { kind: 'commands' }
  | { kind: 'models'; models: { label: string; current: boolean }[] }
  | { kind: 'message'; text: string };

export type SlashCtx = { agentId: string; convId: string };

export type SlashDeps = {
  createConversation(agentId: string, title: string): Promise<Conversation | null>;
  setActive(agentId: string, convId: string | null): void;
  abort(conversationId: string): Promise<void>;
  updateAgent(agentId: string, patch: { approvalMode: ApprovalMode }): Promise<void>;
  listModels(): Promise<RegisteredModel[]>;
  getTwinMain(): Promise<string | null>;
  setMainModel(modelId: string): Promise<void>;
  compress(agentId: string, convId: string): Promise<ConvCompressResultEvent>;
  /** /status 快照：agent 名与挡位（agentStore）、忙闲与排队条数（chatStore）。 */
  agentInfo(agentId: string): { name: string; approvalMode: ApprovalMode } | null;
  isBusy(conversationId: string): boolean;
  queuedCount(conversationId: string): number;
};

/** 生产接线：store 动作 + ws 路由（modelAssignments.update 与设置页同款调用）。 */
export const desktopSlashDeps: SlashDeps = {
  createConversation: (agentId, title) => useConversationStore.getState().create(agentId, title),
  setActive: (agentId, convId) => useConversationStore.getState().setActive(agentId, convId),
  abort: (conversationId) => useChatStore.getState().abort(conversationId),
  updateAgent: (agentId, patch) => useAgentStore.getState().update(agentId, patch),
  listModels: async () => {
    const res = await wsClient.request<ModelsStateEvent>({ type: 'models.list' });
    return res.type === 'models.state' ? res.models : [];
  },
  getTwinMain: async () => {
    const res = await wsClient.request<SettingsStateEvent>({ type: 'settings.get' });
    return res.type === 'settings.state' ? res.settings.modelAssignments.twinMain : null;
  },
  setMainModel: async (modelId) => {
    await wsClient.request<ModelAssignmentsStateEvent>({
      type: 'modelAssignments.update',
      usage: 'twinMain',
      modelId,
    });
  },
  compress: (agentId, convId) =>
    // 超时必须盖住压缩 LLM 上限（90s 单次 + 终校验失败重调一次 ≈ 180s，compress.ts SUMMARY_TIMEOUT_MS）——
    // 默认 30s 会让真实压缩必然假「失败」，且重试时闸还被第一次占着、回执连环撒谎（review C1）。
    wsClient.request<ConvCompressResultEvent>(
      {
        type: 'conv.compress',
        agentId,
        conversationId: convId,
      },
      200_000,
    ),
  agentInfo: (agentId) => {
    const a = useAgentStore.getState().agents.find((x) => x.id === agentId);
    return a ? { name: a.name, approvalMode: a.approvalMode } : null;
  },
  isBusy: (conversationId) => useChatStore.getState().pendingByConv[conversationId] ?? false,
  queuedCount: (conversationId) =>
    (useChatStore.getState().conversations[conversationId] ?? []).filter(
      (m) => m.steering?.state === 'queued',
    ).length,
};

const MODE_NAME_KEY: Record<ApprovalMode, string> = {
  readonly: 'slash.modeReadonly',
  work: 'slash.modeWork',
  danger: 'slash.modeDanger',
};

/** /compress 四态 → 面板文案 key（与平台 compressReceiptKey 同形；两端 i18n 域不同，各收一处）。 */
function compressFeedbackKey(res: ConvCompressResultEvent): string {
  if (res.status === 'compressed') return res.fallback ? 'slash.compress.fallback' : 'slash.compress.compressed';
  if (res.status === 'busy') return 'slash.compress.busy';
  if (res.status === 'empty') {
    return res.emptyReason === 'tooShort' ? 'slash.compress.tooShort' : 'slash.compress.nothingNew';
  }
  return 'slash.compress.failed';
}

/**
 * 拦截判定（ChatArea.onSend 的唯一拦截口，可单测）：命中已解析命令 → 拦。
 * 带附件不拦（命令带附件语义不明，克制不猜）；未知斜杠词 parseCommand 返回 undefined
 * 天然放行（/foo 不被吃掉）。命令面与平台端同套（含 /status——PM 2026-08-01 拍板两端同体验）。
 */
export function shouldInterceptCommand(
  cmd: PlatformCommand | undefined,
  hasAttachments: boolean,
): cmd is PlatformCommand {
  return cmd !== undefined && !hasAttachments;
}

/**
 * 执行一条已解析的命令；返回要弹的面板内容（null = 无面板——有 UI 反射的命令效果即反馈）。
 * 只处理桌面命令面：/status 不在此出现（调用方已放行成普通消息）。
 */
export async function runSlashCommand(
  cmd: PlatformCommand,
  ctx: SlashCtx,
  deps: SlashDeps,
  t: TFunction,
): Promise<SlashPanelState | null> {
  switch (cmd.kind) {
    case 'new': {
      // 同新建按钮语义：conv.create + setActive。不归档当前对话——桌面有归档按钮，命令不抢。
      const created = await deps.createConversation(ctx.agentId, DEFAULT_NEW_CONV_TITLE);
      if (!created) return { kind: 'message', text: t('slash.failed') }; // 建对话失败不静默
      deps.setActive(ctx.agentId, created.id);
      return null;
    }
    case 'stop':
      await deps.abort(ctx.convId);
      return null;
    case 'setMode': {
      if (!cmd.mode) return { kind: 'message', text: t('slash.modeUsage') };
      await deps.updateAgent(ctx.agentId, { approvalMode: cmd.mode });
      return { kind: 'message', text: t('slash.modeSwitched', { mode: t(MODE_NAME_KEY[cmd.mode]) }) };
    }
    case 'model': {
      if (cmd.invalid) return { kind: 'message', text: t('slash.modelUsage') };
      const [models, twinMain] = await Promise.all([deps.listModels(), deps.getTwinMain()]);
      if (models.length === 0) return { kind: 'message', text: t('slash.modelEmpty') };
      if (cmd.index === null) {
        return {
          kind: 'models',
          models: models.map((m) => ({ label: m.label, current: m.id === twinMain })),
        };
      }
      const target = models[cmd.index - 1];
      if (!target) return { kind: 'message', text: t('slash.modelStale') };
      await deps.setMainModel(target.id);
      return { kind: 'message', text: t('slash.modelSwitched', { label: target.label }) };
    }
    case 'compress': {
      const res = await deps.compress(ctx.agentId, ctx.convId);
      if (res.type !== 'conv.compress.result') return { kind: 'message', text: t('slash.compress.failed') };
      return { kind: 'message', text: t(compressFeedbackKey(res)) };
    }
    case 'help':
      return { kind: 'commands' };
    case 'status': {
      // 与飞书端同一份状态快照（PM 2026-08-01 拍板两端同体验）；数据源全在渲染层 store。
      const info = deps.agentInfo(ctx.agentId);
      const [models, twinMain] = await Promise.all([deps.listModels(), deps.getTwinMain()]);
      const modelLabel = models.find((m) => m.id === twinMain)?.label ?? t('slash.statusDefaultModel');
      const queued = deps.queuedCount(ctx.convId);
      const state = deps.isBusy(ctx.convId)
        ? t('slash.statusBusy', { count: queued })
        : t('slash.statusIdle');
      return {
        kind: 'message',
        text: t('slash.statusLine', {
          agent: info?.name ?? 'Oru',
          mode: info ? t(MODE_NAME_KEY[info.approvalMode]) : '-',
          model: modelLabel,
          state,
        }),
      };
    }
    default:
      // 未来新增命令未接调度时不吞。
      return null;
  }
}
