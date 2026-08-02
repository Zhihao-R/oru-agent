/**
 * conv.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 conv.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对动态 import 路径相应多一层 `../`。
 * pushConvState 复用 handlers/convState.ts 的导出，不重写。
 */
import type { ChatMessage } from '@shared/types';
import type { RegistrySlice } from './types';
import { brakeConversation } from './brake';
import { pushConvState } from './convState';
import {
  archiveConversation,
  clearConversation,
  createSubConversation,
  deleteConversation,
  markConversationSeen,
  readHistory,
  renameConversation,
  searchConversations,
} from '../../conversations/store';
import { deleteConversationImages, hydrateAttachmentDisplayUrls } from '../../conversations/attachments';
import { forceCompressConversation } from '../../agent/context/manualCompress';
import { peekRecoveredSteering } from '../../agent/steeringBackup';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';
import { closeBrowserSession } from '../../browser/session';

export const conversationHandlers = {
  'conv.list': async (req, { reply, broadcast }) => {
    await pushConvState(req.agentId, reply, req.reqId, broadcast);
  },
  'conv.create': async (req, { reply, broadcast }) => {
    await createSubConversation(req.agentId, req.title);
    await pushConvState(req.agentId, reply, req.reqId, broadcast);
  },
  'conv.rename': async (req, { reply, broadcast }) => {
    await renameConversation(req.agentId, req.conversationId, req.title);
    await pushConvState(req.agentId, reply, req.reqId, broadcast);
  },
  'conv.delete': async (req, { reply, broadcast }) => {
    // 删除即中止（比桌面按停更强的意图）：先对话级刹车再删数据——停当前轮 + 停该对话派出的
    // 后台任务 / 排队派工 / 后台 bash，否则逃逸任务会往已删对话写消息。被刹任务静默
    // （brakeCancelled 打标）不写报告卡；markAnnounced 抑制播报轮，避免对已删对话起 nudge。
    await brakeConversation(req.agentId, req.conversationId, broadcast);
    closeBrowserSession(req.conversationId); // 该对话的浏览器活页面随对话回收（S33 §5）
    await deleteConversation(req.agentId, req.conversationId);
    await deleteConversationImages(req.agentId, req.conversationId);
    await pushConvState(req.agentId, reply, req.reqId, broadcast);
  },
  'conv.archive': async (req, { reply, broadcast }) => {
    // 手动归档：无 onlyIfInactiveSince（无条件归档），区别于 autoArchiver 的并发护栏路径
    //（autoArchiver 只碰 168h 不活跃的对话，其浏览器会话早被闲置超时回收，无需在那边接线）。
    closeBrowserSession(req.conversationId);
    await archiveConversation(req.agentId, req.conversationId);
    await pushConvState(req.agentId, reply, req.reqId, broadcast);
  },
  'conv.clear': async (req, { reply, broadcast }) => {
    // 清空即中止（与 conv.delete 对齐）：先对话级刹车再清历史——停当前轮 + 停该对话派出的后台
    // 任务 / 排队派工 / 后台 bash，否则逃逸任务会往刚清空的对话写消息。clear 后对话还在（重置成
    // 空白可用回活跃区），但用户要的是「干净重来」，交还 steering 草稿反而与清空矛盾，故只走核心
    // 刹车、不 drain 交还（brakeConversation 本不含 UI 收尾）。被刹任务 brakeCancelled 静默、不写
    // 报告卡，不会污染刚清空的对话；markAnnounced 抑制播报。store 层 killBashForConversation 保留
    // 为幂等防御网（先停后清，与 conv.delete 同一模式）。
    await brakeConversation(req.agentId, req.conversationId, broadcast);
    closeBrowserSession(req.conversationId); // 干净重来含浏览器页面态（S33 §5）
    await clearConversation(req.agentId, req.conversationId);
    await deleteConversationImages(req.agentId, req.conversationId);
    await pushConvState(req.agentId, reply, req.reqId, broadcast);
  },
  'conv.compress': async (req, { reply, broadcast }) => {
    // 桌面 /compress（斜杠命令补全 plan §4）——与平台 /compress 同调一个内核（manualCompress）。
    const r = await forceCompressConversation(req.agentId, req.conversationId, broadcast);
    reply(req.reqId, {
      type: 'conv.compress.result',
      agentId: req.agentId,
      conversationId: req.conversationId,
      status: r.status,
      ...(r.status === 'compressed' ? { fallback: r.fallback } : {}),
      ...(r.status === 'empty' ? { emptyReason: r.emptyReason } : {}),
    });
  },
  'conv.history': async (req, { reply, broadcast }) => {
    const messages = await readHistory(req.agentId, req.conversationId);
    // v0.3：给含图消息塞 file:// URL，供前端 ChatMessage 渲缩略图
    const hydrated = messages.map((m) =>
      hydrateAttachmentDisplayUrls(m as ChatMessage & Record<string, unknown>, req.agentId) as ChatMessage,
    );
    reply(req.reqId, {
      type: 'conv.history.result',
      agentId: req.agentId,
      conversationId: req.conversationId,
      messages: hydrated,
    });
    // 崩溃盘记交还：上次进程残留的未消费 steering → 预填该对话草稿（复用 Esc 退回输入框的形态）。
    // 对话打开必拉历史，借这个时机送达；前端回 chat.steering.recoverAck 后才清盘记（宁重复不丢）。
    const items = peekRecoveredSteering(req.conversationId);
    if (items) {
      broadcast({
        type: 'chat.steering.recovered',
        agentId: req.agentId,
        conversationId: req.conversationId,
        items,
      });
    }
  },
  'conv.search': async (req, { reply }) => {
    const groups = await searchConversations(req.agentId, req.query);
    const totalHits = groups.reduce((n, g) => n + g.messages.length, 0);
    reply(req.reqId, {
      type: 'conv.search.result',
      agentId: req.agentId,
      query: req.query,
      groups,
      totalHits,
    });
  },
  'conv.markSeen': async (req, { reply }) => {
    // 已读水位落盘（通知中心 §5.1）——前端乐观先行，这里 fire-and-forget 持久化。
    // 不广播 conv.state：值随下次常规同步回来即可，避免每次打开都全量推送。
    await markConversationSeen(req.agentId, req.conversationId, req.seenAt);
    reply(req.reqId, { type: 'ack' });
  },
  'conv.getSubagentSidecar': async (req, { reply }) => {
    // 对话期 Subagent（v2）：前端展开 chip 时按 taskId 懒加载 subagent 内部对话
    const ownerId = getCurrentOwnerId();
    const { readSidecar } = await import('../../agent/subagentChat/sidecar');
    const messages = await readSidecar(ownerId, req.agentId, req.conversationId, req.taskId);
    reply(req.reqId, {
      type: 'conv.subagentSidecar.result',
      agentId: req.agentId,
      conversationId: req.conversationId,
      taskId: req.taskId,
      messages,
    });
  },
} satisfies RegistrySlice;
