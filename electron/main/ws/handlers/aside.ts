/**
 * aside.* 命令处理器（随手评点域，D2(a) 迁移）。
 * 行为与原 router.ts switch 内 aside.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对静态/动态 import 路径相应多一层 `../`。
 * buildMainChatTurnArgs / pushConvState 走 handlers/turnArgs.ts / handlers/convState.ts（跨域共用编排内核），不从 router 取。
 */
import { ErrorCodes, type ChatMessage } from '@shared/types';
import { newMessageId } from '@shared/ids';
import type { RegistrySlice } from './types';
import { buildMainChatTurnArgs } from './turnArgs';
import { pushConvState } from './convState';
import { captureMainWindowScreenshot } from '../aside/capture';
import { asideCommentSupportsVision, runAsideComment } from '../aside/comment';
import { buildAsideReferentCard, runAsideBegin } from '../aside/begin';
import { recordAsideEvent } from '../aside/stats';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';
import { isConversationBusy } from '../../agent/runner';
import { runChatAndPersist } from '../runChatAndPersist';
import { getAgent } from '../../agent/store/agents';
import {
  appendMessage,
  getConversation,
  listAsideConversations,
  rekindConversation,
} from '../../conversations/store';
import { hydrateAttachmentDisplayUrls } from '../../conversations/attachments';
import { onUserMessage as dreamOnUserMessage } from '../../memory/dreamScheduler';

export const asideHandlers = {
  'aside.capture': async (req, { reply }) => {
    // 截图以渲染端 ~300ms race 为预算（技术方案 §4）——失败由 server.ts 外层兜底
    // 回错误包，渲染端按设计静默降级为无图评点，不展示错误。
    const screenshot = await captureMainWindowScreenshot();
    reply(req.reqId, { type: 'aside.capture.result', screenshot });
  },
  'aside.comment': async (req, { reply }) => {
    // 朴素计数（二期 §8）：probing 每点必发本请求——⌥ 点次数的 probing 侧分量。
    // 入口即计（不看成败）：点击行为发生了，短评成不成是另一回事
    // 来源透传：浮层窗标 origin:'screen' → 计入窗外子集（唤起对话 PRD §9 度量）
    void recordAsideEvent(getCurrentOwnerId(), 'comment', undefined, req.origin);
    // 失败/超时已在 runAsideComment 内吞掉（返回 null）——回标准错误包即可，
    // 渲染端静默丢弃（技术方案 §5.2），异常不会打到 router 外。
    const text = await runAsideComment(req);
    if (text === null) {
      reply(req.reqId, { type: 'error', code: ErrorCodes.UNKNOWN, message: '短评生成失败' });
    } else {
      reply(req.reqId, { type: 'aside.comment.result', text });
    }
  },
  'aside.begin': async (req, { reply }) => {
    // 截图过评点模型的 vision 闸（二期 §3）：aside 短聊回合喂图的就是评点模型，
    // 落盘与消费一个口径——闸跟着实际消费的模型走，不再看主对话模型
    const visionOk = await asideCommentSupportsVision();
    const { conversation, messages } = await runAsideBegin(req, visionOk);
    // 朴素计数（二期 §8）：开口次数——对话真建起来才算
    void recordAsideEvent(getCurrentOwnerId(), 'begin', undefined, req.origin);
    reply(req.reqId, { type: 'aside.begin.result', conversation, messages });
  },
  'aside.addReferent': async (req, { reply, broadcast }) => {
    // 浮层短聊期间再次 ⌥ 点击：以指代卡为 user 消息跑一轮正常回合（技术方案 §7）。
    // 刻意不走 chat.resume 续跑——ClaudeCode 续跑一律不带图（claudeCode.ts 续跑取图返回空），
    // 指代卡截图会整条丢；作为「带新 user 消息」的正常回合，三后端图片通路全部成立。
    // aside 与普通对话的回合差异由 buildMainChatTurnArgs 按 conv.kind 决定，不在此写死——
    // promote 后渲染端 pending 队列 flush 进已是 sub 的对话照样成立。
    //
    // 撞上进行中的流式轮：回标准错误包带 AGENT_BUSY——渲染端 pending 队列（T11）靠它
    // 重新入队，主进程不做队列。先查忙锁再落卡：忙时指代卡绝不落盘，否则 JSONL 会出现
    // 「指代卡 → 上一问的回复」的错位历史。查锁与起轮之间的窄缝竞态与 chat.send /
    // taskboard.comment.send 同口径（runChat 的忙锁兜底），不另建锁。
    if (isConversationBusy(req.agentId, req.conversationId)) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.AGENT_BUSY,
        message: '该对话正在生成中，本次指认未入队',
      });
      return;
    }
    const agent = await getAgent(req.agentId);
    const conversation = await getConversation(req.agentId, req.conversationId);
    // 朴素计数（二期 §8）：chatting 每递进必发——⌥ 点次数的 chatting 侧分量。
    // 放在忙锁之后：AGENT_BUSY 被拒的请求会由渲染端重发，入口即计会双算同一次点击
    void recordAsideEvent(getCurrentOwnerId(), 'addReferent', undefined, req.origin);
    // 截图过评点模型的 vision 闸——与 aside.begin 同一道闸（二期 §3）；
    // chat.send 的附件闸仍看主模型（浮层不发附件，两闸服务的消费方不同）
    const visionOk = await asideCommentSupportsVision();
    const card = await buildAsideReferentCard({
      agentId: req.agentId,
      conversationId: req.conversationId,
      referent: req.referent,
      screenshot: req.screenshot,
      asideVisionOk: visionOk,
    });
    await appendMessage(req.agentId, req.conversationId, card);
    // 与 chat.send 同口径：user 消息落盘后驱动 dream 调度（capture 触发已收口到 runChatAndPersist）
    dreamOnUserMessage();

    // 响应带 hydrate 后的指代卡，渲染端追加进桶（与 aside.begin.result 的灌桶口径一致）。
    // 刻意先 reply 再广播 chat.started：同一条 ws 顺序送达，渲染端先灌卡再挂流式回应，
    // 桶序天然 = 落盘序（user 卡 → assistant 回应）。
    reply(req.reqId, {
      type: 'aside.addReferent.result',
      message: hydrateAttachmentDisplayUrls(
        card as ChatMessage & Record<string, unknown>,
        req.agentId,
      ) as ChatMessage,
    });
    const messageId = newMessageId();
    broadcast({ type: 'chat.started', conversationId: req.conversationId, messageId });
    void runChatAndPersist(
      buildMainChatTurnArgs({
        agentId: req.agentId,
        agent,
        conversation,
        messageId,
        userText: card.text,
        attachments: card.attachments,
        broadcast,
      }),
    );
  },
  'aside.list': async (req, { reply }) => {
    // 独立事件、不借 conv.state——后者是 main+sub 全量同步 + 整体替换 + 参与 active
    // 计算的语义，aside 查询按需、非全量、不参与 active（技术方案 §7）
    const conversations = await listAsideConversations(req.agentId);
    reply(req.reqId, { type: 'aside.list.result', agentId: req.agentId, conversations });
  },
  'aside.promote': async (req, { reply, broadcast }) => {
    // 入口校验源必须是 aside：store 的 rekind 守卫只挡 main / taskboard-comment，
    // sub→sub 这类无意义迁移在 handler 层拒绝
    const conv = await getConversation(req.agentId, req.conversationId);
    if (conv.kind !== 'aside') {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.UNKNOWN,
        message: 'aside.promote 只接受随手评点（aside）对话',
      });
      return;
    }
    // rekind 只改 kind + updatedAt——消息 / 附件 / sdkSessionId 原地不动，
    // SDK session 里已有这段短聊的上下文，转正后正好接着用（技术方案 §8）
    await rekindConversation(req.agentId, req.conversationId, 'sub');
    // 朴素计数（二期 §8）：转正次数——rekind 成功才算
    void recordAsideEvent(getCurrentOwnerId(), 'promote', undefined, req.origin);
    // 转正后要在主对话列表浮现：先广播 conv.state 再回 ack，
    // 发起方收到 ack 时主列表已更新，切换视图不会扑空
    await pushConvState(req.agentId, null, null, broadcast);
    reply(req.reqId, { type: 'ack' });
  },
} satisfies RegistrySlice;
