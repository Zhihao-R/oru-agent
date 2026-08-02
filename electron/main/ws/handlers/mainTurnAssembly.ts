/**
 * 统一回合装配（S08 · G11 结构收敛）——所有主对话回合的唯一装配单源。
 *
 * 把几乎逐行相同的组合（persistConsumed 落盘+广播 consumed 单源、runTurn 接线
 * chat.started + runChatAndPersist + drainSteering/hasPendingSteering/drainBoundaryNotice、
 * 加 runSteeringTurnLoop 回合循环）收成一个函数，所有起主对话回合的入口共用：
 * chat.send started 分支 / queue.readmit 放行 / 渠道入站（gatewayWiring）/ 后台完成播报
 * （completionAnnounce）/ 冲突恢复（conflictResume）/ artifact「据文稿更新」/
 * startNonUserMainTurn（闸外回合：审批续跑 / [重试]，beginDirectTurn 占闸后跑它）。
 * 原定时投递入口已随 S18 改独立会话执行退场。新增入口必须先占闸（enqueueOrStart 或
 * beginDirectTurn），严禁直调 runChatAndPersist 绕闸（整体验收抓过一例）。
 *
 * 收敛的硬要求（不是顺手清理）：G13 要 runTurn 传回 outcome、G12 要 persistConsumed 分型广播、
 * G11 要闸外回合也接队列——三处都得改，一份总比三份漂移安全（实施方案 §2/§4）。
 *
 * 本函数**不落 firstText**：起回合那条消息（用户消息 / 触发卡）由各入口自己在调用前 appendMessage；
 * 闸外回合的 nudgeText 本就不落 user 气泡（续跑语义）。本函数只管队列项（restart/drain）的落盘。
 */
import type { Agent, ChatAttachment, ChatMessage, Conversation, TriggerOrigin } from '@shared/types';
import { newMessageId } from '@shared/ids';
import type { Broadcast } from '../server';
import { appendMessage } from '../../conversations/store';
import { parseLoopCommand } from '@shared/loop/parseLoopCommand';
import { steeringQueue, steeringKey, type SteeringMsg } from '../../agent/steeringQueue';
import { runSteeringTurnLoop } from '../../agent/steeringTurnLoop';
import { buildMergeAssemblyNotice } from '../../agent/mergeAssembly';
import { runChatAndPersist, type TurnOutcome } from '../runChatAndPersist';
import { buildMainChatTurnArgs } from './turnArgs';
import {
  deliverAssistantToChannels,
  handleChannelProposalIfRemote,
  type TurnInput,
} from './channelOutbound';
import { clearProcessingForItems } from '../../platform/channelProcessing';
import {
  beginLiveTurn,
  endLiveTurn,
  isLiveTurnSuperseded,
  markLiveTurnProduced,
  noteLiveTurnOrigin,
  peekLiveTurnOrigins,
  sameTriggerOrigin,
} from '../../agent/liveTurnMark';

/** 装配一个主回合的静态依赖（占闸凭据 runToken 归属整段回合，drainSteering 复用它校验队列归属）。 */
export type MainTurnRunnerDeps = {
  agentId: string;
  agent: Agent;
  conversation: Conversation;
  broadcast: Broadcast;
  /** 回合归属凭据（§6）：占闸（enqueueOrStart started / beginDirectTurn）返回的 token，原样传入。 */
  runToken: number;
  /**
   * 在飞回合打标（连发合并 S1）：默认开——本对话流过 delta / tool_use 即标「有产出」，
   * 队列据此裁决能不能撤起重跑。Loop 干活轮跨轮持闸、编排层自掌生命周期，必须关掉
   * （否则一条窗口内的连发消息会把 loop 的干活轮当「可撤回合」误杀）。
   */
  watchLiveTurn?: boolean;
};

/** 跑单个回合的可变入参（isFirst 相关的注入项由调用方按轮次决定，见 runAssembledMainTurn）。 */
export type RunOneTurnOpts = {
  /** 本轮 LLM 输入文本；undefined = 续跑（从 history 读）。 */
  userText: string | undefined;
  /** 由 concludeTurn 合并进来的积压批（G70 装配标注取材）；无则不传。 */
  restartBatch?: SteeringMsg[];
  /** 拼进本轮动态 system 段的额外指令（闸外续跑用）；不给则从 restartBatch 派生合并标注。 */
  extraDynamicSystemPrompt?: string;
  /** 本轮首消息附件（仅 userText 有值时生效）。 */
  attachments?: ChatAttachment[];
  /** 起回合那条的渠道来源（S10）。 */
  firstOrigin?: TriggerOrigin;
  /** 断线自动接续（S25）：本轮是自动续写，起回合即广播「正在重试 n/N」。 */
  retryHint?: { attempt: number; maxRetries: number };
};

/** 复用的主回合装配句柄：runOneTurn 跑一个回合（调用方掌控占闸/释闸生命周期，如 Loop 跨轮持闸）。 */
export type MainTurnRunner = {
  key: string;
  persistConsumed: (msgs: SteeringMsg[]) => Promise<void>;
  onHandback: (items: SteeringMsg[]) => void;
  runOneTurn: (opts: RunOneTurnOpts) => Promise<TurnOutcome>;
};

export type AssembleMainTurnDeps = {
  agentId: string;
  agent: Agent;
  conversation: Conversation;
  broadcast: Broadcast;
  /** 回合归属凭据（§6）：占闸（enqueueOrStart started / beginDirectTurn）返回的 token，原样传入。 */
  runToken: number;
  /** 首轮文本：起回合那条（用户消息 / 触发卡文本）；闸外续跑为 nudgeText，可 undefined（从 history 读）。 */
  firstText: string | undefined;
  /** 首轮附件（仅 chat.send 起回合带）；续跑轮不重复带。 */
  attachments?: ChatAttachment[];
  /** 拼进首轮动态 system 段的额外指令（不落 history）——闸外续跑用；续跑轮不重复注入。 */
  extraDynamicSystemPrompt?: string;
  /** 首轮起回合那条的渠道来源（S10）——渠道消息起回合时带，回发与提案远程语义据它判。桌面为 undefined。 */
  firstOrigin?: TriggerOrigin;
  /**
   * 断线自动接续（S25 G23/G03）：本回合是自动续写时带——起回合即对新消息广播 chat.retrying
   *（「正在重试 n/N」），下一条 delta 到达自动清零。仅首轮（续写只跑一轮），不随续跑轮重复。
   */
  retryHint?: { attempt: number; maxRetries: number };
};

/**
 * 造一个可复用的主回合装配句柄——把「persistConsumed 落盘广播 + runOneTurn 接线 chat.started +
 * runChatAndPersist + drainSteering/渠道出站」收成 runOneTurn，**不含**回合循环与占闸/释闸。
 *
 * 两个消费者：runAssembledMainTurn 把它套进 runSteeringTurnLoop（回合末 concludeTurn 释闸）；
 * Loop 编排层直接驱动 runOneTurn 跑每个可见干活轮，**跨轮持闸**、由自己在收敛/中止/停时释闸
 * （§3.1：轮与轮之间不释闸，间隙用户消息落队列、下一轮 drainSteering 消费）。
 */
export function buildMainTurnRunner(deps: MainTurnRunnerDeps): MainTurnRunner {
  const { agentId, agent, conversation, broadcast } = deps;
  const conversationId = conversation.id;
  const key = steeringKey(agentId, conversationId);

  // 一批 steering 在动作边界 / 回合末被读入：落盘为正式 user 历史 + 广播 consumed（单源）。
  // task-completed（G69 后台完成播报）**不落气泡**：它是纯系统信号，播报指令经 G70 合并标注
  // （buildMergeAssemblyNotice）注入模型、未播报任务清单经回合起点 systemContext 带出，历史里
  // 只留 Oru 的播报回复本身（对齐旧 proactiveAnnounce「不旁路 appendMessage」）。
  const persistConsumed = async (msgs: SteeringMsg[]) => {
    const persisted: SteeringMsg[] = [];
    for (const m of msgs) {
      if (m.trigger === 'task-completed') continue; // 无气泡：不 appendMessage、不进 consumed
      const consumed: ChatMessage = {
        id: m.serverId,
        conversationId,
        role: 'user',
        text: m.text,
        toolCalls: [],
        createdAt: Date.now(),
        done: true,
        clientMsgId: m.clientMsgId,
        // 忙时入队的定时触发被 drain 落盘仍带 kind/payload，不退化成普通用户气泡（M3）
        kind: m.kind,
        scheduledTrigger: m.scheduledTrigger,
        // 随消息入队的附件原样落盘（本期队列/盘记/交还全程带引用；桌面附件 G02、渠道 S10）
        attachments: m.attachments,
      };
      await appendMessage(agentId, conversationId, consumed);
      persisted.push(m);
      // 入队的定时触发被 drain 时也实时推触发卡（无对应乐观气泡，靠这条补）
      if (m.kind === 'scheduled-trigger') {
        broadcast({ type: 'chat.scheduledTrigger', conversationId, message: consumed });
      }
    }
    if (persisted.length > 0) {
      broadcast({ type: 'chat.steering.consumed', conversationId, serverIds: persisted.map((m) => m.serverId) });
    }
  };

  // 故障 / 远程刹车后未消费队列的交还（G14）：广播 chat.queue.handback，前端按 handbackForm 分流。
  // Esc 桌面按停走 chat.abort 自己交还草稿，不经这里。SteeringMsg 字段集与 HandbackItem 一致，直接透传。
  const onHandback = (items: SteeringMsg[]) => {
    broadcast({ type: 'chat.queue.handback', conversationId, items });
    // 交还的渠道消息清「处理中」表情（§6：交还 / 清掉时清）——未被消费出站，否则表情永远挂着。
    clearProcessingForItems(items);
  };

  const runOneTurn = async (opts: RunOneTurnOpts): Promise<TurnOutcome> => {
    const mid = newMessageId();
    // 在飞回合打标（S1）：开条早于一切 await——起跑即进入「窗口内可撤」状态；
    // 终了（含被撤 / 故障）finally 销条，token 归属防被撤回合的迟到收尾误销新回合的条。
    const watch = deps.watchLiveTurn ?? true;
    if (watch) beginLiveTurn(key, deps.runToken);
    try {
      // 「无产出」判定单点（承重口径 2）：本对话流过 chat.delta / chat.toolCall 即打标「有产出」——
      // 此后撤起会在桌面留半截 bubble、在渠道留审批/工具卡，队列裁决据此转 busy-enqueue。
      // 别对话的事件走同一 broadcast 实例，必须按 conversationId 过滤。
      const liveBroadcast: Broadcast = (ev) => {
        if (watch && (ev.type === 'chat.delta' || ev.type === 'chat.toolCall') && ev.conversationId === conversationId) {
          markLiveTurnProduced(key, deps.runToken);
        }
        broadcast(ev);
      };
      liveBroadcast({ type: 'chat.started', conversationId, messageId: mid });
      // 断线自动接续：起回合即广播「正在重试 n/N」。下一条 delta 到达时清零。
      if (opts.retryHint) {
        liveBroadcast({
          type: 'chat.retrying',
          conversationId,
          messageId: mid,
          attempt: opts.retryHint.attempt,
          maxRetries: opts.retryHint.maxRetries,
        });
      }
      // extraDynamicSystemPrompt 显式给则用（闸外续跑 / Loop 汇报轮）；否则从 restart 批派生 G70 合并标注。
      const extraDynamicSystemPrompt =
        opts.extraDynamicSystemPrompt ??
        (opts.restartBatch && opts.restartBatch.length > 0 ? buildMergeAssemblyNotice(opts.restartBatch) : undefined);
      // 本回合消费输入的 origin 投影（S10）+ 撤起链继承（S1 承重口径 1：被撤回合已消费的 origins
      // 随重起回合继续承担回发与清表情——custody 在 liveTurnMark，beginLiveTurn 时已继承）。
      // 桌面输入无 origin 不占位（回发 / 清表情两侧本就跳过 undefined）。
      const turnInputs: TurnInput[] = watch ? peekLiveTurnOrigins(key).map((origin) => ({ origin })) : [];
      const addInput = (origin?: TriggerOrigin) => {
        if (!origin) return;
        // 撤起链 custody 已含 seed origin（supersede 就地入账）——按三元组去重，不入第二条。
        if (turnInputs.some((i) => i.origin && sameTriggerOrigin(i.origin, origin))) return;
        turnInputs.push({ origin });
        if (watch) noteLiveTurnOrigin(key, deps.runToken, origin);
      };
      if (opts.firstOrigin) addInput(opts.firstOrigin);
      else for (const m of opts.restartBatch ?? []) addInput(m.origin);
      const baseArgs = buildMainChatTurnArgs({
        agentId,
        agent,
        conversation,
        messageId: mid,
        userText: opts.userText,
        attachments: opts.userText === undefined ? undefined : opts.attachments,
        broadcast: liveBroadcast,
        extraDynamicSystemPrompt,
        // 动作边界 drain：只取 user 项（G12），anthropic/openai 在 tool_result 边界搭车注入。
        // 间隙插入批的 origin 并入 turnInputs——回发对「谁起的回合」不敏感（桌面回合中途插入飞书消息，回复照发飞书）。
        drainSteering: () =>
          steeringQueue.pullSteering(key, deps.runToken, persistConsumed).then((ms) => {
            for (const m of ms) addInput(m.origin);
            return ms.map((m) => m.text);
          }),
        // 待读入探测（非消费）：只看 user 项——机器项入队不该触发 claude-code 工具边界 interrupt（G12）。
        hasPendingSteering: () => steeringQueue.pendingUserCount(key) > 0,
        // 注意（S09/G69）：不再挂 drainBoundaryNotice——后台终态「中途塞入当前回合」正是理想页
        // 明言机器触发不该做的事。后台完成改走统一队列（trigger:'task-completed'）等回合末合并搭车，
        // 未播报任务清单仍由回合起点 systemContext（buildUnannouncedTaskHint）带出。
      });
      // 渠道出站接线（S10）：包一层 baseArgs 的两个回调，纯桌面回合 no-op（buildMainChatTurnArgs
      // 保持平台无关，渠道行为收在整合层）。onProposal 仅在 baseArgs 已有时才包——aside 短聊本就不挂
      // onProposal（保持其「三动手回调全缺席」不变量），且 aside 是独立对话、永无渠道 origin。
      const outcome = await runChatAndPersist({
        ...baseArgs,
        // 回合归属临跑重检（S1 / Esc 竞态闭环）：串联段（入口落盘等 await）期间闸被 Esc 清掉
        // 或被连发撤起翻新 token → 不打这枪，按 aborted 收（runChatAndPersist 在注册控制器前调）。
        isTurnOwned: () => steeringQueue.isRunning(key) && steeringQueue.runToken(key) === deps.runToken,
        ...(baseArgs.onProposal
          ? {
              onProposal: async (proposal) => {
                // 回合输入含渠道 origin → 远程语义（§5，现查 turnInputs）；纯桌面 → 交回桌面卡。
                if (await handleChannelProposalIfRemote({ proposal, turnInputs, conversation, agentId, agent })) return;
                await baseArgs.onProposal!(proposal);
              },
            }
          : {}),
        onAssistantPersisted: async (msg) => {
          await baseArgs.onAssistantPersisted?.(msg);
          // 回合末回发到消费的渠道来源 + 清「处理中」表情（§4 / §6）；纯桌面回合无目标、no-op。
          await deliverAssistantToChannels(turnInputs, conversation, msg.text ?? '');
        },
      });
      // 中断 / 故障（outcome !== 'ok'）走不到 onAssistantPersisted，回发不发、但本回合已消费的渠道
      // 消息（起回合那条 firstOrigin + 间隙插入批 + restart 批）表情得清——否则永久悬挂（S10 review · C1）。
      // 队列里尚未消费的项由 onHandback / chat.abort 各自清，不重叠（clearProcessing 幂等，重复也安全）。
      // 例外（S1 review · I1）：被连发撤起接替（custody 已过户给新 token）时这些 origins 归新回合
      // 清——这里抢清会让渠道「处理中」表情在新回合跑完前提前消失，看着像没受理。
      if (outcome !== 'ok' && !(watch && isLiveTurnSuperseded(key, deps.runToken))) clearProcessingForItems(turnInputs);
      return outcome;
    } finally {
      if (watch) endLiveTurn(key, deps.runToken);
    }
  };

  return { key, persistConsumed, onHandback, runOneTurn };
}

/**
 * 队首轮到模式指令（/loop）的转投（T2 切批）：item 已由 concludeTurn 落盘出队、闸保持
 * running 同 token——转投 loop 编排（编排收尾自行 handBackIfRunning 释闸）。
 * 两个调用点：runAssembledMainTurn 的回合末切批、manualCompress 释闸时队首撞 loop 指令。
 * 动态 import 防循环依赖（orchestrate → buildMainTurnRunner → 本文件）。
 */
export async function handOffLoopFromSteering(args: {
  agentId: string;
  conversationId: string;
  runToken: number;
  broadcast: Broadcast;
  item: SteeringMsg;
}): Promise<void> {
  const { runLoopOrchestrationAndRelease } = await import('../../loop/orchestrate');
  // 入队不变量：chat.ts 只把「isLoop 且有 goal」的 /loop 标成模式指令，goal 恒非空。
  // 收尾三件套（catch 记日志 / 按 token 释闸 / 交还剩余队列）收在编排侧单源，与直起路径共用。
  await runLoopOrchestrationAndRelease({
    agentId: args.agentId,
    conversationId: args.conversationId,
    goal: parseLoopCommand(args.item.text).goal,
    runToken: args.runToken,
    broadcast: args.broadcast,
    attachments: args.item.attachments,
  });
}

/**
 * 跑一个完整主对话回合（含 steering 回合循环）；返回跨轮累积的 TurnOutcome（成/败/中止）。
 * chat.send / startNonUserMainTurn 忽略返回值（fire-and-forget）；定时投递读它判 lastRun。
 * isFirst 相关注入（extraDynamicSystemPrompt / attachments / firstOrigin / retryHint）只随首轮，
 * 续跑轮从 history 读、由 restartBatch 派生合并标注——与重构前逐字等价。
 */
export function runAssembledMainTurn(deps: AssembleMainTurnDeps): Promise<TurnOutcome> {
  const runner = buildMainTurnRunner({
    agentId: deps.agentId,
    agent: deps.agent,
    conversation: deps.conversation,
    broadcast: deps.broadcast,
    runToken: deps.runToken,
  });
  let firstTurn = true;
  return runSteeringTurnLoop({
    key: runner.key,
    token: deps.runToken,
    firstText: deps.firstText,
    persistConsumed: runner.persistConsumed,
    onHandback: runner.onHandback,
    // 队首轮到 /loop（T2 切批）：转投 loop 编排（同 token 持闸），编排收尾释闸 + 交还剩余队列。
    startLoop: (item) =>
      handOffLoopFromSteering({
        agentId: deps.agentId,
        conversationId: deps.conversation.id,
        runToken: deps.runToken,
        broadcast: deps.broadcast,
        item,
      }),
    runTurn: (userText, restartBatch) => {
      const isFirst = firstTurn;
      firstTurn = false;
      return runner.runOneTurn({
        userText,
        restartBatch,
        extraDynamicSystemPrompt: isFirst ? deps.extraDynamicSystemPrompt : undefined,
        attachments: isFirst ? deps.attachments : undefined,
        firstOrigin: isFirst ? deps.firstOrigin : undefined,
        retryHint: isFirst ? deps.retryHint : undefined,
      });
    },
  });
}
