/**
 * 计划清单同步（S32·G49）：切对话 / 断线重连时取初值 + 订阅 chat.todo 广播增量
 * （范式同 useSystemSignalSync）。
 *
 * 取初值这一步不能省：清单按对话落盘、活过重启，只订阅广播的话重启后模型每轮都看得见清单、
 * 用户屏幕上却是空的——比两边一起忘更糟，那至少是对称的。
 */
import { useEffect } from 'react';
import type { ChatTodoEvent } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { onReconnect } from '@/lib/wsReconnect';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useTodoStore } from '@/stores/todoStore';

export function useTodoSync(): void {
  const agentId = useAgentStore((s) => s.activeAgentId);
  const convId = useConversationStore((s) => (agentId ? s.activeByAgent[agentId] ?? null : null));

  useEffect(() => {
    return wsClient.subscribe((ev) => {
      if (ev.type !== 'chat.todo') return;
      useTodoStore.getState().setTodos(ev.conversationId, ev.items);
    });
  }, []);

  useEffect(() => {
    if (!agentId || !convId) return;
    const load = async () => {
      try {
        const res = await wsClient.request<ChatTodoEvent>({
          type: 'chat.todo.list',
          agentId,
          conversationId: convId,
        });
        if (res.type === 'chat.todo') useTodoStore.getState().setTodos(res.conversationId, res.items);
      } catch {
        // 取初值失败无妨——AI 下次更新清单会重推
      }
    };
    void load();
    // 断线期漏掉的更新靠重连重拉对齐（否则卡片停在断线前那一版）
    return onReconnect(() => void load());
  }, [agentId, convId]);
}
