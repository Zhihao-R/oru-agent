/**
 * taskboard.* 命令处理器（D2(a) 迁移域）。
 * 涵盖「任务（PR-A）」与「任务评论（PR-D2）」两小节，行为与原 router.ts switch
 * 内各 taskboard.* case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对 import 路径相应多一层 `../`；
 * 同层 ws 子模块（如 ./errors、./runChatAndPersist）仍是单层 `./`。
 */
import { ErrorCodes, type ChatAttachment, type ChatMessage, type ErrorCode } from '@shared/types';
import { newMessageId } from '@shared/ids';
import type { RegistrySlice } from './types';
import { isConversationBusy } from '../../agent/runner';
import { runChatAndPersist } from '../runChatAndPersist';
import { ensureDefaultAgent } from '../../agent/store/agents';
import { appendMessage, deleteMessage, readHistory, updateSdkSessionId } from '../../conversations/store';
import { AttachmentError, hydrateAttachmentDisplayUrls, saveAttachments } from '../../conversations/attachments';
import * as taskboardStore from '../../taskboard/store';
import {
  deleteTaskboardImages,
  hydrateTaskboardDisplayUrls,
  saveTaskboardAttachments,
} from '../../taskboard/attachments';
import { resolveProjectByTag } from '../../taskboard/resolveProject';
import { buildCommentPrompt } from '../../taskboard/prompt';
import { taskboardEvents } from '../../taskboard/events';
import { errCode, errMsg } from '../errors';

export const taskboardHandlers = {
  // ─── 任务（PR-A）─────────────────────────────────────
  'taskboard.list': async (req, { reply }) => {
    try {
      const tasks = await taskboardStore.listTasks(req.filters ?? {});
      reply(req.reqId, { type: 'taskboard.list.result', tasks });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'taskboard.create': async (req, { reply }) => {
    try {
      let t = await taskboardStore.createTask({
        title: req.title,
        description: req.description,
        status: req.status,
        assignee: req.assignee,
        projectTag: req.projectTag,
      }, /* by */ 'you');
      // 描述图片：建 task 拿到 id 后才落盘（渲染端暂存 base64，取消不发→无孤儿）。
      // 落盘失败不砸掉整条建任务——图存不了也把任务建出来，回执带错误信息。
      if (req.attachments && req.attachments.length > 0) {
        try {
          const saved = await saveTaskboardAttachments(t.id, req.attachments);
          t = await taskboardStore.applyAttachmentDelta(t.id, saved, []);
        } catch (e) {
          console.warn(`[taskboard] create: 图片落盘失败 task=${t.id}:`, e);
          // 图已写盘但没挂上 task（如并发 softDelete）→ 兜底清掉孤儿图片目录
          void deleteTaskboardImages(t.id);
        }
      }
      // store 内部已经 broadcast taskUpsert 给所有客户端；
      // 给请求方回 create.result 携带 meta（含 id），让前端能立即定位到刚建的任务
      reply(req.reqId, { type: 'taskboard.create.result', task: taskboardStore.toMeta(t) });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'taskboard.update': async (req, { reply }) => {
    try {
      await taskboardStore.updateTask(req.id, req.patch);
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'taskboard.delete': async (req, { reply }) => {
    try {
      await taskboardStore.softDeleteTask(req.id, /* by */ 'you');
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'taskboard.restore': async (req, { reply }) => {
    try {
      await taskboardStore.restoreTask(req.id);
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
  'taskboard.get': async (req, { reply }) => {
    try {
      const t = await taskboardStore.getTask(req.id);
      // 落盘 task.json 不带 displayUrl；出口 hydrate 成 oru-board-img:// 供渲染端显示描述图
      reply(req.reqId, {
        type: 'taskboard.get.result',
        task: t ? hydrateTaskboardDisplayUrls(t) : null,
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },

  'taskboard.setAttachments': async (req, { reply }) => {
    try {
      let saved: ChatAttachment[] = [];
      if (req.add && req.add.length > 0) {
        try {
          saved = await saveTaskboardAttachments(req.taskId, req.add);
        } catch (e) {
          const code = e instanceof AttachmentError ? e.code : ErrorCodes.UNKNOWN;
          reply(req.reqId, { type: 'error', code: code as ErrorCode, message: errMsg(e) });
          return;
        }
      }
      // 增量语义：锁内基于最新盘 删 removeRelPaths + 追加 saved（并发增删不互相覆盖）
      const t = await taskboardStore.applyAttachmentDelta(
        req.taskId,
        saved,
        req.removeRelPaths ?? [],
      );
      reply(req.reqId, {
        type: 'taskboard.setAttachments.result',
        task: hydrateTaskboardDisplayUrls(t),
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },

  // ─── 任务评论（PR-D2）─────────────────────────────────
  'taskboard.comments': async (req, { reply }) => {
    try {
      const { conv } = await taskboardStore.ensureCommentConversation(req.taskId);
      // 落盘 jsonl 不带 displayUrl，出口处 hydrate 成 oru-conv-img:// 供渲染端显示图片
      const messages = (await readHistory(conv.agentId, conv.id)).map(
        (m) =>
          hydrateAttachmentDisplayUrls(
            m as ChatMessage & Record<string, unknown>,
            conv.agentId,
          ) as ChatMessage,
      );
      reply(req.reqId, {
        type: 'taskboard.comments.result',
        taskId: req.taskId,
        conversation: conv,
        messages,
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },

  'taskboard.note.add': async (req, { reply }) => {
    try {
      const { conv } = await taskboardStore.ensureCommentConversation(req.taskId);
      const msgId = newMessageId();
      // 图片落盘（与 chat.send 同一套校验）；评论不做 vision 拒绝——非 vision 也照存照显示，
      // 仅 @oru 喂模型时由后端 attachmentLoaderFor 按能力剔除
      let attachments: ChatAttachment[] | undefined;
      if (req.attachments && req.attachments.length > 0) {
        try {
          attachments = await saveAttachments(conv.agentId, conv.id, msgId, req.attachments);
        } catch (e) {
          const code = e instanceof AttachmentError ? e.code : ErrorCodes.UNKNOWN;
          reply(req.reqId, { type: 'error', code: code as ErrorCode, message: errMsg(e) });
          return;
        }
      }
      const userMsg: ChatMessage = {
        id: msgId,
        conversationId: conv.id,
        role: 'user',
        text: req.text,
        toolCalls: [],
        createdAt: Date.now(),
        done: true,
        mentions: req.mentions ?? [],
        attachments,
      };
      await appendMessage(conv.agentId, conv.id, userMsg);
      await taskboardStore.incrementCommentCount(req.taskId);
      reply(req.reqId, {
        type: 'taskboard.note.added',
        taskId: req.taskId,
        tempId: req.tempId,
        // hydrate displayUrl 让前端乐观项替换后能立刻显示落盘图
        message: hydrateAttachmentDisplayUrls(
          userMsg as ChatMessage & Record<string, unknown>,
          conv.agentId,
        ) as ChatMessage,
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },

  'taskboard.note.delete': async (req, { reply }) => {
    try {
      const t = await taskboardStore.getTask(req.taskId);
      if (!t) {
        reply(req.reqId, {
          type: 'error',
          code: ErrorCodes.BOARD_TASK_NOT_FOUND,
          message: `任务 ${req.taskId} 不存在`,
        });
        return;
      }
      // 有评论 conv 才可能有可删的消息；真删了一条才 -1（幂等：重复删同一条不再扣）。
      // 只删这一条 message——@oru 母评论下的 Oru 回复留着（PM 2026-07-15 拍板）。
      if (t.commentConversationId) {
        const agent = await ensureDefaultAgent();
        const deleted = await deleteMessage(agent.id, t.commentConversationId, req.messageId);
        if (deleted) await taskboardStore.decrementCommentCount(req.taskId);
      }
      // 无评论 conv 也回 deleted：让前端清掉本地副本（幂等）
      reply(req.reqId, {
        type: 'taskboard.note.deleted',
        taskId: req.taskId,
        messageId: req.messageId,
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },

  'taskboard.comment.abort': async (req, { reply }) => {
    try {
      const t = await taskboardStore.getTask(req.taskId);
      if (!t) {
        reply(req.reqId, {
          type: 'error',
          code: ErrorCodes.BOARD_TASK_NOT_FOUND,
          message: `任务 ${req.taskId} 不存在`,
        });
        return;
      }
      // 无关联评论 conv → 视为已停（幂等）
      if (t.commentConversationId) {
        const agent = await ensureDefaultAgent();
        // 走事件总线——跟 softDeleteTask 内部的 abort 走同一渠道（系统性：所有
        // taskboard 业务路径触发的 abort 统一从 taskboardEvents 流出）
        taskboardEvents.emit('requestAbort', {
          agentId: agent.id,
          conversationId: t.commentConversationId,
        });
      }
      reply(req.reqId, { type: 'ack' });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },

  'taskboard.comment.send': async (req, { reply, broadcast }) => {
    try {
      // 防御：mentions 必含 'oru'；不含则视为 plain note（前端误用兜底）
      if (!req.mentions.includes('oru')) {
        // 不静默重定向——返回明确错误更好排错
        reply(req.reqId, {
          type: 'error',
          code: ErrorCodes.UNKNOWN,
          message: 'taskboard.comment.send 必须 @oru；纯留言请用 taskboard.note.add',
        });
        return;
      }
      const { conv, task } = await taskboardStore.ensureCommentConversation(req.taskId);
      const agent = await ensureDefaultAgent();

      // 锁占用：reply error + 广播 commentBusy
      if (isConversationBusy(agent.id, conv.id)) {
        broadcast({ type: 'taskboard.commentBusy', taskId: req.taskId });
        reply(req.reqId, {
          type: 'error',
          code: ErrorCodes.BOARD_COMMENT_BUSY,
          message: '该任务下已有 Oru 调用在跑，请稍候',
        });
        return;
      }

      // 1. append 用户消息（mentions 由本路径写入；chat.send 路径构建 ChatMessage 自然不带）
      const userMsgId = newMessageId();
      // 图片落盘（与 chat.send 同一套校验）；vision 模型 @oru 时进模型输入，非 vision 由后端剔除
      let userAttachments: ChatAttachment[] | undefined;
      if (req.attachments && req.attachments.length > 0) {
        try {
          userAttachments = await saveAttachments(
            agent.id,
            conv.id,
            userMsgId,
            req.attachments,
          );
        } catch (e) {
          const code = e instanceof AttachmentError ? e.code : ErrorCodes.UNKNOWN;
          reply(req.reqId, { type: 'error', code: code as ErrorCode, message: errMsg(e) });
          return;
        }
      }
      const userMsg: ChatMessage = {
        id: userMsgId,
        conversationId: conv.id,
        role: 'user',
        text: req.text,
        toolCalls: [],
        createdAt: Date.now(),
        done: true,
        mentions: req.mentions,
        attachments: userAttachments,
      };
      await appendMessage(agent.id, conv.id, userMsg);
      await taskboardStore.incrementCommentCount(req.taskId);

      // 2. 项目解析 + prompt 拼装——必须在 reply 之前，否则两者抛错时
      //    第一个 reply 已 resolve pending 表，第二个 error reply 会被丢弃
      //    → 前端 send Promise 正常返回但 chat.started/done 永不到来 → oruRunning 永远 true
      const projectIdOverride = await resolveProjectByTag(task.projectTag);
      const { stable: extraStable, dynamic: extraDynamic } = buildCommentPrompt({ task });

      // 3. reply（携带真实 id + 透传 tempId；hydrate displayUrl 让前端替换乐观项后显示落盘图）
      reply(req.reqId, {
        type: 'taskboard.note.added',
        taskId: req.taskId,
        tempId: req.tempId,
        message: hydrateAttachmentDisplayUrls(
          userMsg as ChatMessage & Record<string, unknown>,
          agent.id,
        ) as ChatMessage,
      });

      // 4. fire-and-forget 跑 runChat + 持久化（共用 runChatAndPersist；caller 通过
      //    不传 onProposal / onMemoryRecord 表达"评论场景这两条无操作"）
      const messageId = newMessageId();
      broadcast({ type: 'chat.started', conversationId: conv.id, messageId });
      void runChatAndPersist({
        agent,
        conversation: conv,
        messageId,
        userText: req.text,
        emit: (ev) => broadcast(ev),
        onSdkSessionId: async (sid) => {
          await updateSdkSessionId(agent.id, conv.id, sid);
        },
        // 评论场景工具被 deny，proposal/memory 不触发——不传等于 noop（无需 boolean flag）
        // 中断恢复（2026-06）：同主对话——abort 不再写 turn-terminator，半截由 incomplete assistant 承载。
        onContextCompressed: async (msg) => {
          await appendMessage(agent.id, conv.id, msg);
          broadcast({
            type: 'chat.contextCompressed',
            conversationId: conv.id,
            message: msg,
          });
        },
        // PR-D2 评论场景字段
        boardCurrentTaskId: req.taskId,
        projectIdOverride,
        extraStableSystemPrompt: extraStable,
        extraDynamicSystemPrompt: extraDynamic,
        // 委派工具收敛：aside 场景不该有派工入口，deny Task（原 deny propose_action）
        extraToolDenylist: ['Task', 'commit_changes'],
        // debug 模块字段（PR-A）；与 chat.send 一致带上 attachments，排障能看到本轮带了几张图
        // （图片进模型走历史 + attachmentLoaderFor，不依赖这里；这里仅供 debug 日志可观测）
        source: 'comment',
        attachments: userAttachments?.map((a) => ({
          name: a.filename,
          bytes: a.bytes,
          path: a.relPath,
        })),
        // assistant 落盘后 +1 评论计数。chat.done 不在这里发——stream 结束时（stream.ts）
        // 已无条件 emit 一次，与 chat.send 路径同源；这里再发会让评论场景双发同一 messageId。
        onAssistantPersisted: async () => {
          await taskboardStore.incrementCommentCount(req.taskId);
        },
        // 不接 onInterruptedPersisted 是有意的（非遗漏）：评论态未读走评论计数、不看 conv.state
        // 已读水位；被按停的半截也不该 +1 计成一条完整评论。
      });
    } catch (e) {
      reply(req.reqId, { type: 'error', code: errCode(e), message: errMsg(e) });
    }
  },
} satisfies RegistrySlice;
