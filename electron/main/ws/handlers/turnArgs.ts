/**
 * 主对话一轮的入参工厂与其回合收尾副作用清单。
 *
 * buildMainChatTurnArgs：把 chat.send 那一大坨回调接线收敛成一处，chat.send / 审批后续跑 / aside 共用。
 * applyTurnSideEffects：回合真正跑完后要扩散到其他子系统的副作用清单（G27）。
 * 从 shared.ts 按内聚度拆出（D2(a)）。onProposal 记提案走 proposals/registry 的
 * surfaceProposal（注册表已下沉到 proposal 子系统）。
 */
import type { Agent, ChatAttachment, ChatMessage, Conversation } from '@shared/types';
import { newMessageId } from '@shared/ids';
import type { Broadcast } from '../server';
import { appendMessage, updateSdkSessionId } from '../../conversations/store';
import { getAgent } from '../../agent/store/agents';
import { getSettings } from '../../projects/store';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { t } from '../../i18n/t';
import type { RunChatAndPersistArgs } from '../runChatAndPersist';
import { peekAutoContinue, resetAutoContinue, MAX_AUTO_CONTINUE } from '../../agent/autoContinue';
import { shouldAutoExecuteProposal } from '../../proposals/autoExecuteDecision';
import { realtimeApprovalModeFor } from '../../agent/agentTools/approvalGate';
import { enqueue as enqueueTask } from '../../tasks/queue';
import { ASIDE_CHAT_RULES } from '../aside/comment';
import { ASIDE_TOOL_WHITELIST, buildAsideToolDenylist } from '../aside/toolWhitelist';
import { triggerScan as triggerArchiveScan } from '../../conversations/autoArchiver';
import { surfaceProposal } from '../../proposals/registry';
import { pushConvState } from './convState';
import { maybeResumeTurn } from './resumeTurn';

/**
 * 回合收尾副作用清单（S34 · G27，锚 conversation-flow.html#Side）。
 *
 * 回合真正的下游出口——一处枚举「一轮跑完后要扩散到其他子系统的副作用」，取代原先散在
 * onAssistantPersisted 里内联 + 各自为政的触发。清单：
 *   1. 断线自动接续预算复位（断线已恢复，后续断线重获满额）
 *   2. 列表/通知状态推送（conv.state）——前端据 (updatedAt vs lastSeenAt) 重算 badge。
 *      【刻意不动已读水位 lastSeenAt】回合产出的是新内容；收尾若把水位盖成已读会抹掉未读提醒
 *      （回归）。水位只在用户查看时（conv.markSeen）更新——这才是「已读」的正确语义。
 *   3. 归档判断：回合是「刚活跃」的时刻，活跃驱动催一轮归档扫描（定时器降为兜底）。本对话刚
 *      updatedAt、不被归档；扫的是其他久不互动的对话。fire-and-forget、不拖慢收尾。
 *
 * 【自动命名已不在收尾清单】命名前移到 chat.send「首条 user 消息落盘后」即时触发
 * （electron/main/ws/handlers/chat.ts）——不等回合跑完、只凭首条消息命名。
 * 中断/故障轮走不到这里（onAssistantPersisted 只在完整回合末调）——那是刻意的：半截回合不扩散
 * 下游副作用。
 */
export async function applyTurnSideEffects(p: {
  agentId: string;
  conversationId: string;
  broadcast: Broadcast;
}): Promise<void> {
  const { agentId, conversationId, broadcast } = p;
  resetAutoContinue(conversationId);
  await pushConvState(agentId, null, null, broadcast);
  triggerArchiveScan();
}

/**
 * 主对话一轮的 runChatAndPersist 入参工厂——chat.send 与"审批后自动续跑"共用。
 *
 * 把 chat.send 那一大坨回调接线收敛成一处：onProposal（记提案 + 信任模式自动执行）、
 * onMemoryRecord / onSkillEvent / onArtifactSubmissionChanged / onAborted / subagentSupport /
 * onContextCompressed / onAssistantPersisted 全在此。续跑只是 userText=undefined、无 attachments,
 * 复用同一套回调——否则续起来的轮会丢掉记忆/技能/子 agent 等行为。
 *
 * 随手评点（aside）短聊与普通对话的全部差异也收在这里的一个按 conv.kind 的分支——
 * chat.send / chat.resume / aside.addReferent 经过本工厂时自动拿到正确形态。
 */
export function buildMainChatTurnArgs(p: {
  agentId: string;
  agent: Agent;
  conversation: Conversation;
  messageId: string;
  userText: string | undefined;
  attachments: ChatAttachment[] | undefined;
  broadcast: Broadcast;
  /**
   * 拼进该轮 system 动态段的额外片段（不落 history、不进显示）——「据文稿更新」用它承载
   * 文稿全文 + 提交组 id + 手术式约束（决策 D-A：文稿喂模型但不刷屏）。chat.send / 续跑不传。
   */
  extraDynamicSystemPrompt?: string;
  /** Steering：动作边界 drain 回调（仅主对话 chat.send 起回合时注入；comment/aside 不传）。 */
  drainSteering?: () => Promise<string[]>;
  /** Steering：待读入探测（非消费）——claude-code 据此决定是否 interrupt（仅主对话起回合时注入）。 */
  hasPendingSteering?: () => boolean;
  /** 边界系统通知 drain：后台终态随 steering 同边界注入（仅主对话起回合时注入）。 */
  drainBoundaryNotice?: () => Promise<string[]>;
}): RunChatAndPersistArgs {
  const { agentId, agent, conversation, messageId, userText, attachments, broadcast } = p;
  const conversationId = conversation.id;
  const base: RunChatAndPersistArgs = {
    agent,
    conversation,
    messageId,
    userText,
    extraDynamicSystemPrompt: p.extraDynamicSystemPrompt,
    drainSteering: p.drainSteering,
    hasPendingSteering: p.hasPendingSteering,
    drainBoundaryNotice: p.drainBoundaryNotice,
    emit: (ev) => broadcast(ev),
    onSdkSessionId: async (sid) => {
      await updateSdkSessionId(agentId, conversationId, sid);
    },
    onMemoryRecord: async (payload) => {
      // Twin 通过 record_memory 工具写新记忆——构造 memory-record 消息：
      // 1. 持久化到 conversations JSONL（重启后还能看到卡片）
      // 2. 推送 chat.memoryRecord 事件给 renderer
      const memMsg: ChatMessage = {
        id: newMessageId(),
        conversationId,
        role: 'system',
        // preview 空＝整篇覆盖档案（无诚实摘要可贴，见 memory/tools.ts）——退回路径，别留个「已记下 」
        text: `已记下 ${payload.preview || payload.relPath}`,
        toolCalls: [],
        createdAt: Date.now(),
        done: true,
        kind: 'memory-record',
        memoryRecord: payload,
        anchorTo: { messageId },
      };
      await appendMessage(agentId, conversationId, memMsg);
      broadcast({ type: 'chat.memoryRecord', conversationId, message: memMsg });
    },
    onGitHint: async () => {
      // 当天首次要改某个非 git 项目——落一条系统口吻的提示条（无按钮、客观陈述）：
      // 1. 持久化到 conversations JSONL（事后翻对话记录还能看到）
      // 2. 推送 chat.gitHint 事件给 renderer 在对话流插入提示条（SystemNote 直接渲染 text）
      const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
      const name = (await getAgent(agentId).catch(() => null))?.name || 'Oru';
      const msg: ChatMessage = {
        id: newMessageId(),
        conversationId,
        role: 'system',
        text: t('main:gitHint', lang, { name }),
        toolCalls: [],
        createdAt: Date.now(),
        done: true,
        kind: 'git-hint',
      };
      await appendMessage(agentId, conversationId, msg);
      broadcast({ type: 'chat.gitHint', conversationId, message: msg });
    },
    onArtifactSubmissionChanged: async (artifactId) => {
      // AI 收尾提交组后：刷新标注列表 + 转完成态 + 让 webview 热重载看到改后的 HTML
      const { readAnnotations } = await import('../../deck/annotations');
      const { getSubmissionView } = await import('../../deck/submissions');
      const annotations = await readAnnotations(artifactId);
      broadcast({ type: 'artifact.annotationsChanged', artifactId, annotations });
      broadcast({ type: 'artifact.submissionChanged', artifactId, submission: getSubmissionView(artifactId) });
      broadcast({ type: 'artifact.indexChanged', artifactId });
    },
    onSkillEvent: async (payload) => {
      // Skill 模块 v1：activate_plugin / read_skill 工具触发——构造对应 chip：
      // 1. 持久化到 conversations JSONL（重启后还能看到 chip，激活态从历史重建）
      // 2. 推送 chat.skillModule 事件给 renderer
      const chipKind = payload.kind;
      const text =
        chipKind === 'plugin-activate' ? `激活了 ${payload.name} plugin` : `用了 ${payload.name} skill`;
      const id = chipKind === 'plugin-activate' ? payload.pluginId : payload.skillId;
      const msg: ChatMessage = {
        id: newMessageId(),
        conversationId,
        role: 'system',
        text,
        toolCalls: [],
        createdAt: Date.now(),
        done: true,
        kind: chipKind,
        skillModuleAction: { id, name: payload.name },
        anchorTo: { messageId },
      };
      await appendMessage(agentId, conversationId, msg);
      broadcast({ type: 'chat.skillModule', conversationId, message: msg });
    },
    // 中断恢复（2026-06）：abort 不再写 turn-terminator——半截已由 incomplete assistant 承载
    // （它既发 LLM 又有 UI 呈现；terminator 本就不发 LLM、UI 也跳过卡片，纯冗余双写）。
    onContextCompressed: async (msg) => {
      // v0.2 上下文压缩：把通知卡落盘 + 广播给前端在对话流插入卡片
      await appendMessage(agentId, conversationId, msg);
      broadcast({ type: 'chat.contextCompressed', conversationId, message: msg });
    },
    source: 'main_chat',
    attachments: attachments?.map((a) => ({ name: a.filename, bytes: a.bytes, path: a.relPath })),
    // 中断（按停）半截落盘后也同步一次列表——否则顶高的 updatedAt 传不到前端，停在对话里的人
    // 水位追不上、冒出残余「待验收」未读（PM：对话内按停不该有提醒）。只推 conv.state，不 emit
    // chat.done（那是 onAssistantPersisted 的活）。区分「对话内 vs 提醒中心」按停由前端「是不是
    // 正看着这条对话」天然决定（useMarkDisplayedConvSeen 只为显示中的对话盖章），无需后端 source。
    onInterruptedPersisted: async () => {
      await pushConvState(agentId, null, null, broadcast);
    },
    // S25 G23/G03 断线自动接续：流已开后遇可重试上游故障，领配额后延后触发一次前缀续写
    //（复用手动 [重试] 的 maybeResumeTurn）。gate 此刻仍被本回合占着 → 延到回合收尾（gate 释放）后
    // 再续，小退避兼作节流；maybeResumeTurn 的 acquireResume/beginDirectTurn 自挡与用户新消息抢轮。
    onRetryableStreamDrop: async () => {
      const attempt = peekAutoContinue(conversationId); // 只预看、不消费——真起跑时才扣（M2）
      if (attempt === null) return false; // 预算用尽 → 交回红色错误条 + [重试]
      const delay = Math.min(1500 * attempt, 6000);
      setTimeout(() => {
        void maybeResumeTurn(conversationId, broadcast, agentId, { attempt, maxRetries: MAX_AUTO_CONTINUE });
      }, delay);
      return true;
    },
    onAssistantPersisted: async () => {
      // 成功跑完一轮 → 回合收尾副作用清单（G27），全收在 applyTurnSideEffects 一处（清单见其注释）。
      await applyTurnSideEffects({ agentId, conversationId, broadcast });
    },
  };

  // ─── 随手评点（aside）短聊分支：与普通对话的全部差异收在这里（技术方案 §7）───
  // - extraStableSystemPrompt：aside 行为规则（短、口语；能看能查、不动手，动手引导 ↗ 转正）
  // - asideMode：runner 据此裁 systemContext（stable 裸模式 + 不注入 capabilityPrompt，T5）——
  //   否则 prompt 里满是白名单外工具的用法说明，自相矛盾
  // - restrictToolsTo：只读白名单，三后端在工具列表层硬收口（T4）
  // - extraToolDenylist：注册表全量 − 白名单，给 Anthropic/OAI 的第二层保险
  //   （ClaudeCode 的裸名 denylist 因 mcp__oru__ 前缀静默失效，它的收口靠 restrictToolsTo 两面）
  // - 不挂 onProposal / askUserChoice / subagentSupport（纵深兜底）：提案族假成功、
  //   提问挂死整轮、task 派发三类动手面即使有工具漏网也无处着力——
  //   runChatAndPersist 对缺席的 onProposal 落 noop；task 工具缺席 runSubagent 时真 isError
  // runtimeContext 保留（T5 review 遗留的显式决策）：dynamic 段的当前时间 / 项目环境 /
  // target_project_id 指引对白名单读工具有用；其中会教白名单外工具的两段
  // （未播报任务 hint、待收尾提交组 hint）按 conversationId 取数——aside 对话不产生
  // proposal / task / 提交组，恒为空、不会进 prompt。
  if (conversation.kind === 'aside') {
    return {
      ...base,
      extraStableSystemPrompt: ASIDE_CHAT_RULES,
      asideMode: true,
      restrictToolsTo: ASIDE_TOOL_WHITELIST,
      extraToolDenylist: buildAsideToolDenylist(),
    };
  }

  return {
    ...base,
    onProposal: async (proposal) => {
      surfaceProposal(proposal, broadcast);
      // 挡位实时读（PRD 决策三：挡位实时生效）：中途收紧立即生效，不用 turn 起点的 agent 快照。
      // 自动执行口径收敛在 shouldAutoExecuteProposal（与远程渠道 decidePlatformProposal 同一事实源）：
      //   派工（code）不过挡位（S02 · G73）、只读挡其余写类等卡、forceApproval 恒停下等确认。
      // work/danger 按 kind 分发：mcp.* 走异步 registry CRUD，code 走 subagent queue；
      //   proposal.execute（用户点确认）路径不受挡位影响。
      // 与工具侧同一原语取挡（getAgent 抛错时回落 turn 起点的 agent 快照，不崩 onProposal）。
      const mode = await realtimeApprovalModeFor(agentId, agent.approvalMode);
      if (shouldAutoExecuteProposal(proposal, mode)) {
        if (proposal.kind === 'code') {
          enqueueTask({ agentId, proposal, emit: broadcast });
        } else {
          const { runProposalStandalone } = await import('../../proposals/standaloneExec');
          void runProposalStandalone(proposal, broadcast);
        }
      }
    },
    onProposalOutcome: async (proposal, outcome) => {
      // 装卸类执行完成的对话流 chip——唯一落点，与无工具在等时的独立执行器共用同一函数。
      const { writeProposalOutcomeChip } = await import('../../proposals/outcomeChip');
      await writeProposalOutcomeChip(proposal, outcome, broadcast);
    },
    onProposalTrace: async (proposal) => {
      // 留痕卡：只广播，不 rememberProposal（不进注册表、不参与决定），也不经渠道处置那条链
      // ——它承载「审批请求」语义，会把记录拦成等确认，且全放挡下远程不留痕（PM 2026-07-28 拍板）。
      broadcast({ type: 'chat.proposal', conversationId: proposal.conversationId, proposal });
    },
    askUserChoice: async ({ askId, questions }) => {
      // 带选项提问：只广播卡片（与 onProposal 同构）。挂 waiter / await / abort 都在工具 execute 内
      // 用 ctx.abortSignal 完成（见 askUserChoice.ts）；用户提交经 chat.answerUserChoice → settleUserChoice。
      broadcast({ type: 'chat.askUserChoice', conversationId, messageId, askId, questions });
    },
    onCircuitBreak: async ({ breakerId, reason }) => {
      // 断路器跳闸（G01/G04）：只广播跳闸卡。挂 waiter / await / abort 在 circuitBreakerGuard 内用
      // ctx.abortSignal 完成；用户点「继续放行 / 停止」经 chat.circuitBreakDecision → settleBreaker（停止再刹车）。
      broadcast({ type: 'chat.circuitBreak', conversationId, messageId, breakerId, reason });
    },
    subagentSupport: {
      broadcastChip: (chip) => {
        broadcast({ type: 'chat.subagentChip', conversationId, message: chip });
      },
      persistChip: async (chip) => {
        await appendMessage(agentId, conversationId, chip);
        broadcast({ type: 'chat.subagentChip', conversationId, message: chip });
      },
    },
  };
}
