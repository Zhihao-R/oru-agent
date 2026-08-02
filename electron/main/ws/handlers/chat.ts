/**
 * chat.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 chat.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对动态 import 路径相应多一层 `../`。
 *
 * buildMainChatTurnArgs / maybeResumeTurn 从 ./turnArgs / ./resumeTurn 取（跨域共享的 turn 编排内核）。
 * currentTwinSupportsVision 曾是本文件私有（单消费者时内联）；平台入站图成为第二个消费者后
 * 抽到 agent/backends/visionSupport.ts 共享。
 */
import { ErrorCodes, type ChatAttachment, type ChatMessage, type ErrorCode, type ToolCall } from '@shared/types';
import { newMessageId } from '@shared/ids';
import type { RegistrySlice } from './types';
import { brakeConversation } from './brake';
import { maybeResumeTurn } from './resumeTurn';
import { resetAutoContinue } from '../../agent/autoContinue';
import { runAssembledMainTurn } from './mainTurnAssembly';
import { restartCleanMainTurn, supersedeCleanTurn } from './restartCleanTurn';
import { currentTwinSupportsVision } from '../../agent/backends/visionSupport';
import { checkBackendReady } from '../../agent/backends/readiness';
import { getAgent } from '../../agent/store/agents';
import { appendMessage, getConversation } from '../../conversations/store';
import { AttachmentError, saveAttachments } from '../../conversations/attachments';
import { steeringQueue, steeringKey } from '../../agent/steeringQueue';
import { ackRecoveredSteering } from '../../agent/steeringBackup';
import { parseLoopCommand } from '@shared/loop/parseLoopCommand';
import { runLoopOrchestrationAndRelease } from '../../loop/orchestrate';
import { errMsg } from '../errors';
import { onUserMessage as dreamOnUserMessage } from '../../memory/dreamScheduler';
import { clearProcessingForItems } from '../../platform/channelProcessing';
import { listPendingAsksForConversation } from '../../proposals/pendingUserChoice';
import { readActivePartial } from '../../agent/runner';
import { readTurnInflight } from '../../agent/turnInflight';

export const chatHandlers = {
  'chat.send': async (req, { reply, broadcast }) => {
    const agent = await getAgent(req.agentId);
    const conversation = await getConversation(req.agentId, req.conversationId);
    const conversationId = req.conversationId;
    // 用户发新消息＝新意图：重置断线自动接续预算，让后续断线重获满额自动续写（S25）。
    resetAutoContinue(conversationId);
    // Steering：clientMsgId 由前端生成；老客户端不传时兜底（老客户端忙时锁输入、不会走入队路径）
    const clientMsgId = req.clientMsgId ?? newMessageId();

    const key = steeringKey(req.agentId, conversationId);

    // 图片附件——服务端二次校验（前端 visionEnabled 门控的兜底）+ 落盘。**放在准入裁决之前**：
    // 起回合、忙时入队插话（G02 带附件的插话）与 /loop 三路共用同一门控与限制（Loop 不另立口径），
    // 且此刻尚未占闸，bail 无需释放刚起的回合。
    let attachments: ChatAttachment[] | undefined;
    if (req.attachments && req.attachments.length > 0) {
      if (!(await currentTwinSupportsVision())) {
        reply(req.reqId, {
          type: 'error',
          code: ErrorCodes.ATTACHMENT_BAD_FORMAT,
          message: '当前 Twin 主对话模型不支持视觉，无法发送图片',
        });
        return;
      }
      try {
        // 用 clientMsgId 命名附件目录（起回合/入队/loop 三路统一）；relPath 即引用，与最终消息 id 无关。
        attachments = await saveAttachments(req.agentId, conversationId, clientMsgId, req.attachments);
      } catch (e) {
        const code = e instanceof AttachmentError ? e.code : ErrorCodes.UNKNOWN;
        reply(req.reqId, { type: 'error', code: code as ErrorCode, message: errMsg(e) });
        return;
      }
    }

    // Loop 模式入口（统一手动 /loop）：以 /loop 开头且带目标 → 走收敛编排，不进普通 chat 回合。
    // G71 过准入闸：/loop 也占准入闸——忙时不并发起编排（会与在跑回合并发写同一对话历史）。
    // 忙时入普通消息队列（T2 去特殊化）：带模式指令标记（不作插话、不计 pendingUserCount），
    // 由 concludeTurn 在它处切批、单独转投编排（mainTurnAssembly.startLoop）。空闲则原子占闸直起。
    const loopCmd = parseLoopCommand(req.text);
    if (loopCmd.isLoop && loopCmd.goal) {
      const decision = await steeringQueue.enqueueOrStart(key, {
        clientMsgId,
        text: req.text,
        trigger: 'user',
        modeCommand: 'loop',
        attachments,
      });
      if (decision.action === 'enqueued') {
        // 与普通消息同款回执：排队气泡由前端乐观消息承载，消费前崩溃有盘记交还兜底。
        broadcast({
          type: 'chat.steering.added',
          conversationId,
          clientMsgId,
          serverId: decision.serverId,
        });
        reply(req.reqId, { type: 'ack' });
        return;
      }
      const loopToken = decision.token;
      try {
        await appendMessage(req.agentId, conversationId, {
          id: newMessageId(),
          conversationId,
          role: 'user',
          text: req.text,
          toolCalls: [],
          createdAt: Date.now(),
          done: true,
          attachments,
          clientMsgId,
        });
      } catch (e) {
        // 落盘失败必须释放刚占的闸，否则对话永久卡「运行中」——按 token 归属释放（§6）：
        // await 间隙 Esc+新回合起跑后，裸 drain 会误清别人的闸。
        await steeringQueue.handBackIfRunning(key, loopToken);
        throw e;
      }
      dreamOnUserMessage();
      reply(req.reqId, { type: 'ack' });
      // 编排 + 收尾三件套（释闸/交还/清表情）收在 runLoopOrchestrationAndRelease 单源，
      // 与排队转投路径（mainTurnAssembly.startLoop）共用。
      void runLoopOrchestrationAndRelease({
        agentId: req.agentId,
        conversationId,
        goal: loopCmd.goal,
        runToken: loopToken,
        broadcast,
        attachments,
      });
      return;
    }

    // 唯一裁决者：服务端锁内原子裁决「起回合 vs 入队」——杜绝并发回合（前端只乐观显示）。
    // trigger:'user'——桌面用户消息，有轮次间隙插入资格（G12）；附件随项入队（G02）。
    const decision = await steeringQueue.enqueueOrStart(key, {
      clientMsgId,
      text: req.text,
      trigger: 'user',
      attachments,
    });

    if (decision.action === 'enqueued') {
      // 忙时入队（G02 带附件的插话）：附件随项入队，队列/盘记/交还全程带引用，消费时经
      // persistConsumed 落盘、喂给模型。不落正式历史——消费=落盘先于投递，推迟到动作边界
      // pullSteering / 回合末 concludeTurn；入队已在队列锁内留崩溃盘记（含附件引用），消费前崩溃则
      // 重启后交还草稿、不静默蒸发。前端排队气泡由乐观消息承载（本地已持有附件预览）。
      broadcast({
        type: 'chat.steering.added',
        conversationId,
        clientMsgId,
        serverId: decision.serverId,
      });
      reply(req.reqId, { type: 'ack' });
      return;
    }

    if (decision.action === 'restart') {
      // 连发撤起重跑（S1）：在飞回合窗口内且无产出——撤掉带更全历史重跑，与渠道同源。
      // supersede 必须同步紧随决策（首个 await 前）：决策到杀之间只隔微任务，delta 溜不进来。
      // 不预检后端（在飞回合一秒内刚过同一检查）、不广播 steering.added（消息直接进新回合）。
      supersedeCleanTurn(req.agentId, conversationId, decision.token);
      await restartCleanMainTurn({
        agentId: req.agentId,
        agent,
        conversation,
        broadcast,
        runToken: decision.token,
        clientMsgId,
        text: req.text,
        attachments,
      });
      dreamOnUserMessage();
      reply(req.reqId, { type: 'ack' });
      return;
    }

    // started：起回合——但先做「后端可用?」前置检查（G28，锚 conversation-flow.html#Backend）。
    // 检查前移到 user 落盘之前：后端不可用（未配置 / 鉴权失败 / 网络不通）时立即回执并保留重连
    // 入口，此刻 user 消息尚未进历史、刚占的闸随即释放——历史与队列均无损（对齐理想态「失败零代价」）。
    // 忙时入队路径（decision.action==='enqueued'）不预检：那条只是排队，起跑归属在跑的回合，
    // 由回合末合并或下一轮起跑时的兜底检查承接（不误拒该排队、不违反「忙时排队不报错」）。
    const ready = await checkBackendReady('twinMain');
    // await 后重检承重状态（§6 归属重检）：检查期间用户可能已 Esc（chat.abort 清了闸），甚至
    // 新回合已起（token 已翻新）——只看 isRunning 会把别人的回合当成自己的。凭据失配就此打住。
    if (!steeringQueue.isRunning(key) || steeringQueue.runToken(key) !== decision.token) return;
    if (!ready.ok) {
      await steeringQueue.handBackIfRunning(key, decision.token);
      reply(req.reqId, { type: 'error', code: ErrorCodes.AGENT_NO_AUTH, message: ready.hint });
      return;
    }

    // 落盘起回合那条 user 消息（含 attachments）
    const now = Date.now();
    const userMsgId = newMessageId();
    const userMsg: ChatMessage = {
      id: userMsgId,
      conversationId,
      role: 'user',
      text: req.text,
      toolCalls: [],
      createdAt: now,
      done: true,
      attachments,
      clientMsgId,
    };
    try {
      await appendMessage(req.agentId, conversationId, userMsg);
    } catch (e) {
      // 落盘失败必须释放刚占的闸，否则对话永久卡「运行中」、后续消息只入队不起回合——
      // 按 token 归属释放（§6），不误清 await 间隙里可能已起的新回合。
      await steeringQueue.handBackIfRunning(key, decision.token);
      throw e;
    }
    dreamOnUserMessage();
    reply(req.reqId, { type: 'ack' });

    // 起回合 → 跑统一回合装配（回合循环 + 分型 drain + 故障交还，单源见 mainTurnAssembly）。
    void runAssembledMainTurn({
      agentId: req.agentId,
      agent,
      conversation,
      broadcast,
      runToken: decision.token,
      firstText: req.text,
      attachments,
    });
    return;
  },
  'chat.abort': async (req, { reply, broadcast }) => {
    // Esc：先取走未消费的「将生效」退回输入框（UI 收尾，桌面独有——已消费的已落盘留历史），
    // 再走对话级刹车（理想架构 subagent.html#PFail）：停当前轮 + 停该对话派出的后台任务 /
    // 排队未起跑的派工 / 对话自己的后台命令，不留「以为停了其实还在跑」。刹车编排（含时序
    // 不变量与静默呈现）收在 brakeConversation，与删除对话 / 远程 /stop 共用同一份。
    const key = steeringKey(req.agentId, req.conversationId);
    const unconsumed = await steeringQueue.drainUnconsumedOnAbort(key);
    await brakeConversation(req.agentId, req.conversationId, broadcast);
    // 交还的渠道排队消息清「处理中」表情（§6：交还 / 清掉时清）——未被消费出站。
    clearProcessingForItems(unconsumed);
    // G14：交还携带类型化 items（SteeringMsg 字段集与 HandbackItem 一致，直接透传）——前端按
    // handbackForm 分流：桌面用户亲手打的字回填草稿、机器触发 / 渠道消息列成待处理项。
    reply(req.reqId, {
      type: 'chat.abortResult',
      conversationId: req.conversationId,
      items: unconsumed,
    });
    return;
  },
  'chat.steering.withdraw': async (req, { reply }) => {
    // 撤回仍在队列、未读入的「将生效」；已被读入则回 alreadyConsumed（气泡落定为已读入）
    const key = steeringKey(req.agentId, req.conversationId);
    const result = await steeringQueue.withdraw(key, req.clientMsgId);
    reply(req.reqId, {
      type: 'chat.steering.withdrawResult',
      conversationId: req.conversationId,
      clientMsgId: req.clientMsgId,
      result,
    });
    return;
  },
  'chat.queue.readmit': async (req, { reply, broadcast }) => {
    // 放行一个待处理项（G14）：按原投影重新 enqueueOrStart（trigger/payload/attachments 原样），
    // 对话空闲即起回合、忙时排队。空闲起回合时其 firstText 由重新入队后的回合装配从 history 读入
    // （started 路径经 concludeTurn 续跑读 restart 批）——此处只负责重新入队，不直接起装配。
    const { item } = req;
    const key = steeringKey(req.agentId, req.conversationId);
    const decision = await steeringQueue.enqueueOrStart(key, {
      clientMsgId: item.clientMsgId,
      text: item.text,
      trigger: item.trigger,
      origin: item.origin,
      attachments: item.attachments,
      kind: item.kind,
      scheduledTrigger: item.scheduledTrigger,
    });
    // 空闲 → started：起回合跑装配（放行的项即首轮文本）。忙时 → enqueued：排队等回合末合并。
    if (decision.action === 'restart') {
      // 放行的用户项撞上窗口内无产出的在飞回合（S1）：与 chat.send 的连发撤起同义——
      // 撤起重跑带上这条。只可能是普通用户项（trigger 非 user 或模式指令不会裁出 restart）。
      supersedeCleanTurn(req.agentId, req.conversationId, decision.token, item.origin);
      let agent;
      let conversation;
      try {
        agent = await getAgent(req.agentId);
        conversation = await getConversation(req.agentId, req.conversationId);
      } catch (e) {
        await steeringQueue.handBackIfRunning(key, decision.token);
        throw e;
      }
      await restartCleanMainTurn({
        agentId: req.agentId,
        agent,
        conversation,
        broadcast,
        runToken: decision.token,
        clientMsgId: item.clientMsgId,
        text: item.text,
        attachments: item.attachments,
        origin: item.origin,
      });
    } else if (decision.action === 'started') {
      let agent;
      let conversation;
      try {
        agent = await getAgent(req.agentId);
        conversation = await getConversation(req.agentId, req.conversationId);
      } catch (e) {
        // 取数失败必须释放刚占的闸，否则对话永久卡「运行中」——按 token 归属释放（§6）
        await steeringQueue.handBackIfRunning(key, decision.token);
        throw e;
      }
      // 起回合那条先落盘（带 kind/payload/attachments），与 chat.send / deliver 起回合口径一致。
      const startMsg: ChatMessage = {
        id: newMessageId(),
        conversationId: req.conversationId,
        role: 'user',
        text: item.text,
        toolCalls: [],
        createdAt: Date.now(),
        done: true,
        clientMsgId: item.clientMsgId,
        kind: item.kind,
        scheduledTrigger: item.scheduledTrigger,
        attachments: item.attachments,
      };
      try {
        await appendMessage(req.agentId, req.conversationId, startMsg);
      } catch (e) {
        // 落盘失败必须释放刚占的闸（否则对话永久卡「运行中」）——按 token 归属释放（§6）
        await steeringQueue.handBackIfRunning(key, decision.token);
        throw e;
      }
      if (item.kind === 'scheduled-trigger') {
        broadcast({ type: 'chat.scheduledTrigger', conversationId: req.conversationId, message: startMsg });
      }
      // 附件必须随首轮带进装配，否则放行带图项时图片没喂给模型（实施方案 §6「全程带引用」）。
      // 渠道来源的待处理项放行 → firstOrigin 带上，回发照发回该渠道（S10）。
      void runAssembledMainTurn({
        agentId: req.agentId,
        agent,
        conversation,
        broadcast,
        runToken: decision.token,
        firstText: item.text,
        attachments: item.attachments,
        firstOrigin: item.origin,
      });
    } else {
      broadcast({
        type: 'chat.steering.added',
        conversationId: req.conversationId,
        clientMsgId: item.clientMsgId,
        serverId: decision.serverId,
      });
    }
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'chat.steering.recoverAck': async (req, { reply }) => {
    // 崩溃盘记交还的送达确认：前端已并入草稿——此刻才清盘记（交还即清，同一批不交还两次）
    await ackRecoveredSteering(req.conversationId);
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'chat.answerUserChoice': async (req, { reply }) => {
    // 带选项提问的用户回答——按 askId 唤醒等待的 tool.execute（回答作为 tool_result 回原轮）。
    // settle 落空（已 abort / 重复提交）忽略即可，前端卡片已置灰。
    const { settleUserChoice } = await import('../../proposals/pendingUserChoice');
    settleUserChoice(req.askId, req.answers);
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'chat.circuitBreakDecision': async (req, { reply, broadcast }) => {
    // 断路器跳闸决定（G01/G04）：按 breakerId 唤醒挂起的工具执行。stop 先 settle 再刹停本回合
    // （刹车会 abort，settle 落空也没关系——guard 的 await 收到 abort 同样当 stop）。
    const { settleBreaker } = await import('../../proposals/pendingCircuitBreaker');
    settleBreaker(req.breakerId, req.decision);
    if (req.decision === 'stop') {
      await brakeConversation(req.agentId, req.conversationId, broadcast);
    }
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'chat.resume': async (req, { reply, broadcast }) => {
    // [重试] 续跑：从 history 末尾接着干（复用审批后自动续跑机制），不落新 user 消息。
    reply(req.reqId, { type: 'ack' });
    void maybeResumeTurn(req.conversationId, broadcast, req.agentId);
    return;
  },
  'chat.pendingTurnState.query': async (req, { reply }) => {
    // 睡眠唤醒对账：从主进程拉该对话的「真相快照」。running=steeringQueue 是否占闸（回合在途）；
    // pendingAsks=waiter 仍在等的提问卡；inflightPartial=在途半截（优先 runner 内存完整镜像，
    // 回落到 turnInflight 草稿）。对账只读、幂等，前端唤醒推 / mount 兜底拉都安全。
    const key = steeringKey(req.agentId, req.conversationId);
    const running = steeringQueue.isRunning(key);
    const pendingAsks = listPendingAsksForConversation(req.agentId, req.conversationId);
    // 内存镜像优先：含睡眠前最后一段未节流写盘的完整半截（文档 sleep-wake-chat-recovery L1）。
    const memPartial = readActivePartial(req.agentId, req.conversationId);
    let inflightPartial: { messageId: string; text: string; toolCalls: ToolCall[] } | null = null;
    if (memPartial) {
      inflightPartial = {
        messageId: memPartial.messageId,
        text: memPartial.partial.resultText,
        toolCalls: memPartial.partial.toolCalls,
      };
    } else {
      // 草稿回退（进程内存不可读——理论上睡眠场景不发生，兜底覆盖）。
      const draft = await readTurnInflight(req.agentId, req.conversationId);
      if (draft) {
        inflightPartial = {
          messageId: draft.messageId,
          text: draft.partial.resultText,
          toolCalls: draft.partial.toolCalls,
        };
      }
    }
    reply(req.reqId, {
      type: 'chat.pendingTurnState.result',
      conversationId: req.conversationId,
      running,
      pendingAsks,
      inflightPartial,
    });
    return;
  },
  'chat.pendingTurnState.list': async (_req, { reply }) => {
    // mount 兜底拉：列出当前在途对话（窗口重开后 wake 推收不到的路径）。只返回 conversationId，
    // 前端对每个 id 再走 chat.pendingTurnState.query 拿明细——复用同一份对账逻辑。
    const { computeInFlightConversations } = await import('../wakeRecovery');
    const convs = computeInFlightConversations();
    reply(_req.reqId, {
      type: 'chat.pendingTurnState.list.result',
      conversationIds: convs.map((c) => c.conversationId),
    });
    return;
  },
} satisfies RegistrySlice;
