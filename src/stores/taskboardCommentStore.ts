/**
 * 任务评论本地状态。
 *
 * 不复用主 chatStore——评论场景事件子集少（不需要 proposal / taskReport / memoryRecord），
 * 独立维护一份事件 reducer。代码与主 chatStore 有 ~50 行重复，待 v2 抽 applyChatEvent
 * 公共纯函数；本期不动主 chatStore（388 行，重构风险高）。
 *
 * 数据流：
 *   - TaskDetailPanel 挂载 CommentThread → loadHistory(taskId)
 *     → wsClient.request taskboard.comments → 拉到 conversation + messages
 *     → conversationStore.registerConversation（让 byId 注册评论 conv）
 *     → messagesByTaskId[taskId] = messages
 *   - CommentInput.send → wsClient.request taskboard.note.add / comment.send
 *     乐观插入临时 user msg → applyNoteAdded 替换为真实
 *   - App.tsx ws subscribe（chat.*）→ useCommentChatRouter 分流 → applyChatEvent
 */
import { create } from 'zustand';
import type { ChatMessage, BoardActorId, ToolResult } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { insertContextCompressed } from '@/lib/contextCompressedInsert';
import { wsClient } from '@/lib/ws';
import {
  toOptimisticAttachments,
  toWireAttachments,
  revokeBlobUrls,
  type PendingAttachment,
} from '@/lib/imageAttachments';
import { useConversationStore } from './conversationStore';

type CommentState = {
  messagesByTaskId: Record<string, ChatMessage[]>;
  oruRunningByTaskId: Record<string, boolean>;
  /** 已拉过历史的 taskId 集合，避免重复请求 */
  loadedTaskIds: Set<string>;

  /** 拉历史；服务端会原子返回 conversation + messages，前端把 conv 注册到 byId */
  loadHistory: (taskId: string) => Promise<void>;
  /** 发送评论：mentions 含 'oru' 走 comment.send；否则走 note.add。attachments 可选（图片） */
  send: (
    taskId: string,
    text: string,
    mentions: BoardActorId[],
    attachments?: PendingAttachment[],
  ) => Promise<void>;
  /** 处理 chat.* 事件（router 分流时调用） */
  applyChatEvent: (taskId: string, ev: ServerEvent) => void;
  /** 处理 taskboard.note.added：把 tempId 占位项替换为真实 message */
  applyNoteAdded: (taskId: string, tempId: string | undefined, message: ChatMessage) => void;
  /** 删一条评论（用户留言）；移除由 applyNoteDeleted（回执）统一处理 */
  deleteComment: (taskId: string, messageId: string) => Promise<void>;
  /** 处理 taskboard.note.deleted：从列表移除该 message */
  applyNoteDeleted: (taskId: string, messageId: string) => void;
};

function makeAssistantPlaceholder(messageId: string, conversationId: string): ChatMessage {
  return {
    id: messageId,
    conversationId,
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: Date.now(),
    done: false,
  };
}

export const useTaskboardCommentStore = create<CommentState>((set, get) => ({
  messagesByTaskId: {},
  oruRunningByTaskId: {},
  loadedTaskIds: new Set<string>(),

  loadHistory: async (taskId) => {
    if (get().loadedTaskIds.has(taskId)) return;
    try {
      const res = await wsClient.request({ type: 'taskboard.comments', taskId });
      if (res.type !== 'taskboard.comments.result') return;
      // 把评论 conv 注册进 conversationStore.byId（重启后首开任务详情时让 chat 事件正确路由）
      useConversationStore.getState().registerConversation(res.conversation);
      set((s) => {
        // 替换前 revoke 旧消息遗留的乐观 blob（与 chatStore.loadHistory 对齐；
        // 正常流程此处为空，断连/重启后重新加载时兜底防泄漏）
        const old = s.messagesByTaskId[taskId] ?? [];
        for (const m of old) revokeBlobUrls(m.attachments);
        return {
          messagesByTaskId: { ...s.messagesByTaskId, [taskId]: [...res.messages] },
          loadedTaskIds: new Set([...s.loadedTaskIds, taskId]),
        };
      });
    } catch (e) {
      console.warn('[taskboardCommentStore] loadHistory 失败:', e);
    }
  },

  send: async (taskId, text, mentions, attachments) => {
    const trimmed = text.trim();
    const hasAttachment = !!attachments && attachments.length > 0;
    // 仅图无文也允许发；既无图也无文 → 不发
    if (!trimmed && !hasAttachment) return;
    const tempId = `tmp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    // 乐观插入：用 conversationId 占位（拿不到真实 convId 时用 taskId 字符串兜底；
    // applyNoteAdded 收到真实 message 后会整条替换）。图片用 blob displayUrl 即时显示。
    const optimisticAttachments = hasAttachment ? toOptimisticAttachments(attachments!) : undefined;
    const optimistic: ChatMessage = {
      id: tempId,
      conversationId: '__pending__',
      role: 'user',
      text: trimmed,
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
      mentions,
      attachments: optimisticAttachments,
    };
    set((s) => {
      const list = s.messagesByTaskId[taskId] ?? [];
      return {
        messagesByTaskId: { ...s.messagesByTaskId, [taskId]: [...list, optimistic] },
      };
    });

    const wantsOru = mentions.includes('oru');
    try {
      const wireAttachments = hasAttachment ? await toWireAttachments(attachments!) : undefined;
      if (wantsOru) {
        // 进入 Oru 调用：本地标记 running
        set((s) => ({
          oruRunningByTaskId: { ...s.oruRunningByTaskId, [taskId]: true },
        }));
        await wsClient.request({
          type: 'taskboard.comment.send',
          taskId,
          text: trimmed,
          mentions,
          tempId,
          attachments: wireAttachments,
        });
      } else {
        await wsClient.request({
          type: 'taskboard.note.add',
          taskId,
          text: trimmed,
          mentions,
          tempId,
          attachments: wireAttachments,
        });
      }
    } catch (e) {
      console.warn('[taskboardCommentStore] send 失败:', e);
      // 失败时移除乐观插入项（不留空消息）+ revoke 它的 blob，避免泄漏
      revokeBlobUrls(optimisticAttachments);
      set((s) => {
        const list = s.messagesByTaskId[taskId] ?? [];
        return {
          messagesByTaskId: {
            ...s.messagesByTaskId,
            [taskId]: list.filter((m) => m.id !== tempId),
          },
          oruRunningByTaskId: { ...s.oruRunningByTaskId, [taskId]: false },
        };
      });
    }
  },

  applyNoteAdded: (taskId, tempId, message) => {
    set((s) => {
      const list = s.messagesByTaskId[taskId] ?? [];
      // 优先按 tempId 替换；找不到则 push（重复拉历史 / race 兜底）
      const idx = tempId ? list.findIndex((m) => m.id === tempId) : -1;
      if (idx >= 0) {
        // 替换前 revoke 乐观项的 blob URL（真实 message 带 oru-conv-img:// displayUrl）
        revokeBlobUrls(list[idx].attachments);
        const next = list.slice();
        next[idx] = message;
        return { messagesByTaskId: { ...s.messagesByTaskId, [taskId]: next } };
      }
      // 同 id 已存在 → 跳过
      if (list.some((m) => m.id === message.id)) return s;
      return { messagesByTaskId: { ...s.messagesByTaskId, [taskId]: [...list, message] } };
    });
  },

  deleteComment: async (taskId, messageId) => {
    try {
      await wsClient.request({ type: 'taskboard.note.delete', taskId, messageId });
      // 实际移除等 applyNoteDeleted（服务端回执）——与 applyNoteAdded 对称，单一来源
    } catch (e) {
      console.warn('[taskboardCommentStore] deleteComment 失败:', e);
    }
  },

  applyNoteDeleted: (taskId, messageId) => {
    set((s) => {
      const list = s.messagesByTaskId[taskId] ?? [];
      const target = list.find((m) => m.id === messageId);
      if (!target) return s;
      // 兜底 revoke（真实评论图是 oru-conv-img://、无 blob；乐观项才有 blob）
      revokeBlobUrls(target.attachments);
      return {
        messagesByTaskId: {
          ...s.messagesByTaskId,
          [taskId]: list.filter((m) => m.id !== messageId),
        },
      };
    });
  },

  applyChatEvent: (taskId, ev) => {
    set((s) => {
      const list = s.messagesByTaskId[taskId] ?? [];
      switch (ev.type) {
        case 'chat.started': {
          // 加 assistant placeholder + 标记 running
          const exists = list.some((m) => m.id === ev.messageId);
          const nextList = exists
            ? list
            : [...list, makeAssistantPlaceholder(ev.messageId, ev.conversationId)];
          return {
            messagesByTaskId: { ...s.messagesByTaskId, [taskId]: nextList },
            oruRunningByTaskId: { ...s.oruRunningByTaskId, [taskId]: true },
          };
        }
        case 'chat.delta': {
          let idx = list.findIndex((m) => m.id === ev.messageId);
          let nextList = list;
          if (idx === -1) {
            // 没占位过 → 自动占位（race fallback）
            nextList = [...list, makeAssistantPlaceholder(ev.messageId, ev.conversationId)];
            idx = nextList.length - 1;
          }
          const target = nextList[idx];
          const updated: ChatMessage = {
            ...target,
            text: ev.delta.textChunk ? target.text + ev.delta.textChunk : target.text,
            retryAttempt: undefined,
          };
          const out = nextList.slice();
          out[idx] = updated;
          return { messagesByTaskId: { ...s.messagesByTaskId, [taskId]: out } };
        }
        case 'chat.toolCall': {
          let idx = list.findIndex((m) => m.id === ev.messageId);
          let baseList = list;
          if (idx === -1) {
            baseList = [...list, makeAssistantPlaceholder(ev.messageId, ev.conversationId)];
            idx = baseList.length - 1;
          }
          const target = baseList[idx];
          const existIdx = target.toolCalls.findIndex((t) => t.id === ev.tool.id);
          const nextCalls =
            existIdx >= 0
              ? target.toolCalls.map((t, i) => (i === existIdx ? { ...t, ...ev.tool } : t))
              : [...target.toolCalls, ev.tool];
          const out = baseList.slice();
          out[idx] = { ...target, toolCalls: nextCalls };
          return { messagesByTaskId: { ...s.messagesByTaskId, [taskId]: out } };
        }
        case 'chat.toolResult': {
          const idx = list.findIndex((m) => m.id === ev.messageId);
          if (idx === -1) return s;
          const target = list[idx];
          const result: ToolResult = ev.result;
          const nextCalls = target.toolCalls.map((t) =>
            t.id === result.toolCallId
              ? {
                  ...t,
                  status: result.isError ? ('error' as const) : ('success' as const),
                  result,
                  finishedAt: Date.now(),
                }
              : t,
          );
          const out = list.slice();
          out[idx] = { ...target, toolCalls: nextCalls };
          return { messagesByTaskId: { ...s.messagesByTaskId, [taskId]: out } };
        }
        case 'chat.done': {
          const idx = list.findIndex((m) => m.id === ev.messageId);
          const nextList = idx === -1
            ? list
            : list.map((m, i) => (i === idx ? { ...m, done: true } : m));
          return {
            messagesByTaskId: { ...s.messagesByTaskId, [taskId]: nextList },
            oruRunningByTaskId: { ...s.oruRunningByTaskId, [taskId]: false },
          };
        }
        case 'chat.error': {
          const idx = list.findIndex((m) => m.id === ev.messageId);
          if (idx === -1) {
            return {
              oruRunningByTaskId: { ...s.oruRunningByTaskId, [taskId]: false },
            };
          }
          const out = list.slice();
          out[idx] = {
            ...out[idx],
            error: { message: ev.message, retryable: ev.retryable },
          };
          return {
            messagesByTaskId: { ...s.messagesByTaskId, [taskId]: out },
            oruRunningByTaskId: { ...s.oruRunningByTaskId, [taskId]: false },
          };
        }
        case 'chat.retrying': {
          const idx = list.findIndex((m) => m.id === ev.messageId);
          if (idx === -1) return s;
          const out = list.slice();
          out[idx] = { ...out[idx], retryAttempt: ev.attempt };
          return { messagesByTaskId: { ...s.messagesByTaskId, [taskId]: out } };
        }
        case 'chat.contextCompressed': {
          // 插到被压缩内容之后而非末尾（一期文档 §四），同 id 去重由 helper 负责
          const next = insertContextCompressed(list, ev.message);
          if (next === list) return s;
          return { messagesByTaskId: { ...s.messagesByTaskId, [taskId]: next } };
        }
        default:
          return s;
      }
    });
  },
}));
