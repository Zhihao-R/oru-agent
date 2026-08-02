/**
 * router 的 chat.send / taskboard.comment.send 共用的"跑 chat + 持久化 + 错误回报"
 * fire-and-forget 块。
 *
 * 设计原则：
 * - 不重新发明回调形状——直接 Pick<InnerRunChatArgs>，回调签名跟 runChat 保持一致
 * - 不另造 `extras` 名词袋：能透传给 runChat 的字段平铺到顶层
 * - 不用 `suppressProposal: boolean` flag：caller 不传 onProposal 即「这条回合没人能点」
 *   （用空缺表达空缺，比布尔显式"压制"更克制）。**空缺必须一路透传到 ToolContext，不许在这里
 *   补一个 noop**：审批类工具正是据「onProposal 挂没挂」判断该不该进同步等待，noop 会让它们
 *   等一个永不到来的决定——评论回合调装卸类工具整轮挂死就是这么来的。
 * - "差异化的额外动作"靠回调暴露：
 *     - onProposal / onMemoryRecord：chat 路径传真实回调，comment 路径不传
 *     - onAssistantPersisted：assistant message 落盘后调用（chat 走 pushConvState；
 *       comment 走 incrementCommentCount）
 *
 * chat.done 的唯一来源：
 * - success 路径由 stream（stream.ts 流结束）无条件 emit 一次——chat.send / comment.send 同源，
 *   onAssistantPersisted 不再各自补发（补发会按 messageId 双发）
 * - error 路径在本文件 catch 末尾发 chat.error + chat.done（stream 抛错没走到那次 emit）
 */
import type { BackendType, ChatMessage } from '@shared/types';
import { ErrorCodes } from '@shared/types';
import { classifyError } from '../agent/util/retry';
import {
  isConversationBusy,
  runChat,
  clearActivePartial,
  type RunArgs as InnerRunChatArgs,
  type RunChatResult,
} from '../agent/runner';
import { appendMessage } from '../conversations/store';
import { readInterruptedTurn, buildInterruptedMessage } from '../agent/interrupted';
import { clearTurnInflight } from '../agent/turnInflight';
import { sweepSettledTodos } from '../agent/todoSweep';
import { onAssistantMessage as captureOnAssistantMessage } from '../memory/captureScheduler';
import { errCode, errMsg } from './errors';
import { t } from '../i18n/t';
import { resolveEffectiveLang } from '../i18n/effectiveLang';
import { getSettings } from '../projects/store';

export type RunChatAndPersistArgs = Pick<
  InnerRunChatArgs,
  | 'agent'
  | 'conversation'
  | 'messageId'
  | 'userText'
  | 'emit'
  | 'onSdkSessionId'
  | 'onMemoryRecord'
  | 'onGitHint'
  | 'onArtifactSubmissionChanged'
  | 'onContextCompressed'
  | 'onSkillEvent'
  | 'boardCurrentTaskId'
  | 'projectIdOverride'
  | 'extraStableSystemPrompt'
  | 'extraDynamicSystemPrompt'
  | 'extraToolDenylist'
  | 'restrictToolsTo'
  | 'asideMode'
  | 'source'
  | 'attachments'
  | 'subagentSupport'
  | 'askUserChoice'
  | 'onCircuitBreak'
  | 'drainSteering'
  | 'hasPendingSteering'
  | 'drainBoundaryNotice'
> & {
  /**
   * 分身递交提案时的回调——可选。
   * - chat.send 传真实回调（rememberProposal + 信任模式 enqueue）
   * - comment.send 不传（评论场景工具 deny，proposal 不会触发；不传 = noop）
   */
  onProposal?: InnerRunChatArgs['onProposal'];
  /** 留痕卡回调（装卸类免审批执行完的记录卡）——与 onProposal 同为可选，不挂即不留卡。 */
  onProposalTrace?: InnerRunChatArgs['onProposalTrace'];
  /** 装卸类执行完成后的 chip 回调——同上，不挂即不落 chip。 */
  onProposalOutcome?: InnerRunChatArgs['onProposalOutcome'];
  /**
   * assistant message 落盘后的额外动作。
   * - chat.send 传 `() => pushConvState(...)`
   * - comment.send 传 `async () => { await incrementCommentCount(...); emit chat.done }`
   */
  onAssistantPersisted?: (msg: ChatMessage) => Promise<void>;
  /**
   * 中断（用户按停 / 上游挂）半截 incomplete 落盘后的额外动作——**只做列表同步**（chat.send
   * 传 `() => pushConvState(...)`），绝不 emit chat.done（那会与 catch 末尾无条件的 chat.done 双发，
   * 也正是当初中断路径不复用 onAssistantPersisted 的原因）。
   *
   * 为什么需要它：中断落盘会顶高对话 updatedAt，但此前中断路径不推 conv.state → 停在对话里看着
   * 它被按停的人，已读水位（lastSeenAt）永远追不上这次 updatedAt → 下次常规同步冒出「已完成
   * （待验收）」未读徽标（PM 拍板：对话内按停不该有提醒）。补这一次同步后，前端
   * useMarkDisplayedConvSeen 会为「正显示中的对话」把水位盖上去（没在看的对话不盖 = 提醒中心
   * 按停保持未读，两入口的区分天然由「是不是正看着」决定，无需给 chat.abort 加 source）。
   */
  onInterruptedPersisted?: (msg: ChatMessage) => Promise<void>;
  /**
   * 断线自动接续（S25 · G23/G03）：流已开后遭遇**可重试**的上游故障、且已保留半截时调用，入参是
   * 刚落盘的 incomplete 消息。返回 true 表示调用方已接手自动续写——此时**抑制红色错误条**（只留半截
   * incomplete，续写在另一轮接上）；返回 false（预算用尽 / 未接线）则照常落错误条 + [重试]。
   * 只主对话装配路径挂（buildMainChatTurnArgs）；comment / subagent 不挂 = 不自动续写。
   */
  onRetryableStreamDrop?: (incomplete: ChatMessage) => Promise<boolean>;
  /**
   * 回合归属临跑重检（S1 连发撤起 / Esc 竞态闭环）：装配层注入「闸仍归本回合」的判定。
   * 从占闸到此隔着 await（入口落盘、sweepSettledTodos 等），期间闸可能已被 Esc 清掉、或被连发
   * 撤起翻新 token——不重检则旧回合照跑 runChat、与新回合并发写同一对话（abort 只对已注册的
   * 控制器有效，尚未注册的杀不到）。调用点在 runChat 注册控制器之前的最后一个同步段（其后到
   * 注册零 await），并在空回合退避重发前再检一次。返回 false → 按 'aborted' 收（不落盘、不广播，
   * 与 Esc 被抢同形）。
   */
  isTurnOwned?: () => boolean;
};


/**
 * 空回合（正文空 + 零工具调用）的回合层自动重试。
 *
 * 为什么在这一层而不是流层：两个后端各有各的流层重试，边界都在「这次请求是否失败」或
 * 「流是否在吐出内容前就断了」——空回合是流正常开、正常关、内容为空，两条路都够不着它。
 * 流层拒绝重试的理由（吐出内容后重发会造成重复）在这里不成立：空回合按定义没有任何外部
 * 可见副作用，原样重发是安全的。
 *
 * 退避数组既定次数也定时长（长度即上限），不另设一个会和它对不上的次数常量。
 * 实测最长的空回合空转了 549 秒，无上限的重试会把等待翻几倍，故 2 次封顶。
 */
let emptyRetryBackoffMs = [1000, 3000];

/** 测试用：把退避缩到毫秒级，别让每条空回合用例干等 4 秒。返回还原函数。 */
export function __setEmptyRetryBackoffForTest(ms: number[]): () => void {
  const prev = emptyRetryBackoffMs;
  emptyRetryBackoffMs = ms;
  return () => {
    emptyRetryBackoffMs = prev;
  };
}

/**
 * 托管后端（claude-code）不纳入回合层重试：SDK 在调 API **之前**就把 prompt 落进了 session
 * （见 backends/sessionPoison.ts 的背景），原样重发会让同一条 user 消息在 session 里出现两次，
 * 而这条路正是已知的续传 400 毒化来路。等有真机验证再决定是否放开。
 */
function mayRetryEmptyTurn(backendType: BackendType): boolean {
  return backendType !== 'claude-code';
}

/** 正文与工具调用双零——「模型交了白卷」的唯一判据，重试与落错误条共用它。 */
function isEmptyTurn(r: RunChatResult): boolean {
  return r.resultText.trim().length === 0 && r.toolCalls.length === 0;
}

/**
 * 跑一轮；交白卷就原样重发，直到有产出或退避额度用完。归属丢失（Esc 清闸 / 连发撤起翻新
 * token）时返回 'aborted'——不把空结果落错误卡、更不在退避后重跑：新一轮的控制器可能还没
 * 注册，busy() 看不见它（S1 review · C1）。
 *
 * 每次重发前后各重检一次忙态与归属：退避期间本对话不再占着 abort 槽位，用户可能已经发了
 * 新消息开了新一轮——撞上就收手，不跟新一轮抢（仓库约定：await 后重检共享状态）。
 *
 * `chat.started` / `chat.retrying` 压到真要重发的那一刻才发：早发会在退避的那几秒里点亮一个
 * 按不动的停止按钮（`runChat` 已经把 abort 槽位还回去了），收手时那对括号还合不上。
 */
async function runTurnWithEmptyRetry(args: {
  agent: RunChatAndPersistArgs['agent'];
  conversation: RunChatAndPersistArgs['conversation'];
  emit: RunChatAndPersistArgs['emit'];
  messageId: string;
  runOnce: () => Promise<RunChatResult>;
  isTurnOwned?: () => boolean;
}): Promise<RunChatResult | 'aborted'> {
  const { agent, conversation, emit, messageId, runOnce, isTurnOwned } = args;
  const busy = () => isConversationBusy(agent.id, conversation.id);
  const owned = () => !isTurnOwned || isTurnOwned();
  let result = await runOnce();
  for (const [i, backoffMs] of emptyRetryBackoffMs.entries()) {
    if (!isEmptyTurn(result) || !mayRetryEmptyTurn(result.backendType) || busy()) break;
    await new Promise((r) => setTimeout(r, backoffMs));
    // 归属复核先于忙态（S1 review · C1 常见分支）：闸被夺（Esc / 连发撤起）时，即便新一轮已
    // 占位（busy=true 会走 break），也绝不能把这份空结果交出去落错误卡——按中止收，零痕迹。
    if (!owned()) return 'aborted';
    if (busy()) break;
    emit({ type: 'chat.started', conversationId: conversation.id, messageId });
    emit({
      type: 'chat.retrying',
      conversationId: conversation.id,
      messageId,
      attempt: i + 1,
      maxRetries: emptyRetryBackoffMs.length,
    });
    result = await runOnce();
  }
  return result;
}

/**
 * 一轮的最终结果。定时任务据此把 lastRun 判成 成功/失败/中止（三态复用同一词汇）：
 * - 'ok'：正常跑完。
 * - 'aborted'：用户按停了这一轮（reason='aborted'，按 signal 状态判、backend 无关）——
 *   与「不 emit chat.error」同源，让定时触发的回合被按停时既不误记成功、也不误报失败。
 * - 'error'：真失败（upstream_error / 无 interruptedTurn / 空产出），同刻已 emit chat.error。
 * chat.send / comment 等 caller 不读返回值（fire-and-forget）；定时任务投递据它记 lastRun、
 * loop 干活轮据它判「未正常结束」、steeringTurnLoop 据它决定交还队列（G13）。
 */
export type TurnOutcome = 'ok' | 'aborted' | 'error';

export async function runChatAndPersist(args: RunChatAndPersistArgs): Promise<TurnOutcome> {
  const { agent, conversation, messageId, emit, onAssistantPersisted, onInterruptedPersisted, onRetryableStreamDrop, onProposal, isTurnOwned, ...runArgs } = args;
  // 回合消息的 createdAt 盖「回合开始」而非落盘时刻：信息流按 createdAt 排序，回合中途
  // 注入的卡（memory-record / git-hint / skill chip）时间戳夹在开始与结束之间——直播时
  // 渲染层以回合开始参与排序，落盘若盖结束时刻，重载后 assistant 会排到中途卡之后，
  // 卡从流底跳到用户气泡下。成功与中断半截两路共用，保证直播/重载顺序一致。
  const turnStartedAt = Date.now();
  // 上一轮把计划做完了 → 这一轮开始时清掉那份清单（撤卡 + 删盘）。放在回合开始而非上一轮结束，
  // 理由见 todoSweep 头注释（那张卡最有价值的一帧正是「全做完」）。
  await sweepSettledTodos({
    ownerId: agent.ownerId,
    agentId: agent.id,
    convId: conversation.id,
    emit,
  });
  // 回合归属临跑重检（S1 竞态闭环）：其后到 runChat 注册控制器零 await——Esc / 连发撤起
  // 在串联段夺走闸的，本回合就此打住，不与新回合并发跑（abort 杀不到未注册的控制器）。
  if (isTurnOwned && !isTurnOwned()) return 'aborted';
  try {
    const retried = await runTurnWithEmptyRetry({
      agent,
      conversation,
      emit,
      runOnce: () =>
        runChat({
          agent,
          conversation,
          messageId,
          emit,
          onProposal,
          ...runArgs,
        }),
      messageId,
      isTurnOwned,
    });
    // 空回合退避段归属丢失（S1 review · C1）：按中止收——不落错误卡、不广播，与 Esc 被抢同形。
    if (retried === 'aborted') return 'aborted';
    const result = retried;
    // 归属末检（S1 review · C1 真机变体）：被撤回合的 LLM 调用若已「秒回」完成（撤起的 abort
    // 杀不到已结束的请求、空产出重试也可能不命中如托管后端），result 会一路走到空产出落卡——
    // 撤起语义是零痕迹，归属已失的回合任何结果都不落盘、不广播。
    if (isTurnOwned && !isTurnOwned()) return 'aborted';

    // 空产出判定（PM 拍板 2026-07-26）：正文与工具调用双零的「成功」= 出错。模型可能
    // 「HTTP 200 但正文空」（reasoning-only / 空回复，hy3 前科）——此前当正常完成落盘，
    // UI 不渲染空文本 → 用户零感知，且这条隐形「正常完成」毒化前端 retryLast 分流
    // （误判成可重发、复制旧 user 消息）。改为：error 字段随消息落盘（重启后红条仍在、
    // retryLast 走就地重生成）+ emit chat.error（实时红条 + 通知中心语义）+ outcome='error'
    // （loop 干活轮如实判败、steering 队列按 G13 交还）。文案按 sawReasoning 区分
    // 「思考了但没给出回答 / 压根没响应」，给用户「模型抽风 vs 没响应」的判断依据。
    const emptyCompletion = isEmptyTurn(result);
    let emptyError: ChatMessage['error'];
    if (emptyCompletion) {
      const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
      const key = result.sawReasoning ? 'main:chat.emptyCompletionAfterReasoning' : 'main:chat.emptyCompletion';
      emptyError = { message: t(key, lang), retryable: true };
    }

    const assistantMsg: ChatMessage = {
      id: messageId,
      conversationId: conversation.id,
      role: 'assistant',
      text: result.resultText,
      toolCalls: result.toolCalls,
      createdAt: turnStartedAt,
      done: true,
      backendType: result.backendType,
      toolProtocol: result.toolProtocol,
      modelId: result.modelId,
      providerId: result.providerId,
      ...(emptyError ? { error: emptyError } : {}),
    };
    await appendMessage(agent.id, conversation.id, assistantMsg);
    // 落盘后即时驱动记忆捕获（触发检查从历史数轮次）——时机与中断路径保持一致。
    // 带上本回合的项目归属（评论场景按 task.projectTag 走，与桌面当前项目无关），
    // 让抓到的记忆挂对项目
    captureOnAssistantMessage(agent.id, conversation.id, runArgs.projectIdOverride);
    if (emptyError) {
      // 空产出**不走** onAssistantPersisted——它承载「完整回合」副作用（渠道回发 msg.text 会把
      // 空文本发到飞书/Discord、归档扫描/自动命名也不该被空回合触发），且 mainTurnAssembly 的
      // 「outcome !== 'ok' 走不到 onAssistantPersisted」不变量（渠道表情清理靠它兜）必须成立。
      // 列表同步走 onInterruptedPersisted（其文档语义即「非完整回合落盘后只推 conv.state」）——
      // 落盘顶高了 updatedAt，不同步则水位追不上、冒残余未读徽标（同中断路径的既有论证）。
      if (onInterruptedPersisted) await onInterruptedPersisted(assistantMsg);
      emit({
        type: 'chat.error',
        conversationId: conversation.id,
        messageId,
        code: ErrorCodes.EMPTY_COMPLETION,
        message: emptyError.message,
        retryable: true,
      });
      return 'error';
    }
    if (onAssistantPersisted) await onAssistantPersisted(assistantMsg);
    return 'ok';
  } catch (e) {
    // 留诊断标签——上线后排障靠这条 warn 知道是 chat 流抛错（而非 reply error）
    console.warn(
      `[runChatAndPersist] conv=${conversation.id} msg=${messageId} threw:`,
      e,
    );
    // 中断恢复：带半截的中断 → 先落一条 incomplete assistant 消息（报错逻辑不变，照常走下面）。
    const interruptedTurn = readInterruptedTurn(e);
    let incomplete: ChatMessage | null = null;
    if (interruptedTurn) {
      incomplete = buildInterruptedMessage(
        interruptedTurn,
        { id: messageId, conversationId: conversation.id },
        turnStartedAt,
      );
      if (incomplete) {
        try {
          await appendMessage(agent.id, conversation.id, incomplete);
          // 中断回合也是一条已落盘的 turn——与成功路径一致地即时驱动记忆捕获（项目归属同上）。
          // 但**不**调 onAssistantPersisted：它承载「完整回合」语义（chat 推会话态、comment 计评论数，
          // 还会再 emit 一次 chat.done → 与下方 catch 末尾双发），半截中断回合不纳入。
          captureOnAssistantMessage(agent.id, conversation.id, runArgs.projectIdOverride);
          // 只做列表同步（推 conv.state），让停在对话里的人已读水位追上这次 updatedAt，
          // 不再残留「待验收」未读徽标（详见 onInterruptedPersisted 注释）。
          if (onInterruptedPersisted) await onInterruptedPersisted(incomplete);
        } catch (persistErr) {
          console.warn('[runChatAndPersist] persist incomplete failed', persistErr);
        }
      }
    }
    // 用户主动刹停不算错误：不 emit chat.error——它会置 message.error → conversationStatus
    // 'errored' → 通知中心「需要你处理」，用户自己按的停不该进去。对话内「已中断」呈现由前端
    // 乐观 abortedByUser + 上面落盘的 interrupted 半截驱动，与 chat.error 无关，不受影响。
    // 判定用 runner 挂的 reason（按 abortController.signal 状态、backend 无关），不靠错误文案。
    const userAborted = interruptedTurn?.reason === 'aborted';

    // 错误分类只算一次（classifyError 对 AbortError 会抛——非 userAborted 却抛属罕见 abort 变体，
    // classified=null，下面自动接续跳过、报错走通用 error 分支）。
    let classified: ReturnType<typeof classifyError> | null = null;
    if (!userAborted) {
      try {
        classified = classifyError(e);
      } catch {
        classified = null;
      }
    }

    // S25 G23/G03 断线自动接续：流已开后（有半截 incomplete）遭遇**可重试**的上游故障，交调用方
    // 自动前缀续写——接手成功则抑制红色错误条（半截保留，续写在另一轮接上）。仅 upstream_error
    // 且判可重试（排除密钥/权限等永久故障）才够格；用户按停、不可重试错走常规报错路。
    let autoContinuing = false;
    if (
      !userAborted &&
      incomplete &&
      interruptedTurn?.reason === 'upstream_error' &&
      onRetryableStreamDrop &&
      classified?.retryable
    ) {
      autoContinuing = await onRetryableStreamDrop(incomplete);
    }

    if (!userAborted && !autoContinuing) {
      if (classified) {
        emit({
          type: 'chat.error',
          conversationId: conversation.id,
          messageId,
          code: classified.code,
          message: classified.message,
          retryable: classified.retryable,
        });
      } else {
        // AbortError 变体走通用 error
        emit({ type: 'error', code: errCode(e), message: errMsg(e) });
      }
    }
    emit({ type: 'chat.done', conversationId: conversation.id, messageId });
    return userAborted ? 'aborted' : 'error';
  } finally {
    // S03：本回合已走完正式落盘（成功一条完整消息 / 优雅中断一条半截 / 空半截不落盘）——
    // 清掉流式崩溃恢复草稿。只有真·进程崩溃才会跳过这里、把草稿留给下次启动扫描补回。
    await clearTurnInflight(agent.id, conversation.id);
    // 唤醒对账内存镜像同步清：回合已正式落盘（成功/中断），半截不再需要留档。
    clearActivePartial(agent.id, conversation.id);
  }
}
