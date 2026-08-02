/**
 * 找人阶梯第二级（S30·G51）渲染端接线：把「需要你处理」集合推给主进程（应用不在前台时它弹系统通知 + 设程序坞
 * 角标），并接主进程「点了通知」的广播切到对应对话。判定沿用窗口内 L1 同一份（useNotificationItems.needAction），
 * 口径一致——角标计数 == 通知中心黄点集合。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DesktopAttentionItem } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useNotificationItems } from '@/lib/useNotifications';

export function useDesktopAttention(setPage: (page: 'chat') => void): void {
  const { t } = useTranslation('notification');
  const activeId = useAgentStore((s) => s.activeAgentId);
  const { needAction } = useNotificationItems(activeId);

  // title=对话名（认得出是哪条）、body=为何找你（按 state 取词）；文案在渲染端组好，主进程只照弹。
  // 只盯 active agent 的待处理集合——Oru 当前单活跃 agent，通知项的 agentId 恒 == activeId，点通知 setActive
  // 也切在同一 agent 下（与全仓单 agent 约定一致）。t 入依赖是有意的：切语言时 t 引用变 → items 重算 → 重推，
  // OS 通知文案随之跟上（别删 t 依赖）。
  const items = useMemo<DesktopAttentionItem[]>(
    () =>
      activeId
        ? needAction.map((it) => ({
            agentId: activeId,
            convId: it.conv.id,
            title: it.conv.title?.trim() || t('desktop.fallbackTitle'),
            body: t(`desktop.${it.state}`, { defaultValue: t('desktop.awaiting-answer') }),
          }))
        : [],
    [needAction, activeId, t],
  );

  // 集合变化才推（主进程边沿去重，这里再省一层 WS 往返）。
  const lastSent = useRef<string>('');
  useEffect(() => {
    const key = JSON.stringify(items);
    if (key === lastSent.current) return;
    lastSent.current = key;
    void wsClient.request({ type: 'desktop.attention', items }).catch(() => {});
  }, [items]);

  // 点系统通知 → 主进程 focus 窗口后广播这条，切到对应对话（复用 setActive，打开即标记已读）。
  useEffect(() => {
    return wsClient.subscribe((ev) => {
      if (ev.type !== 'desktop.openConversation') return;
      useConversationStore.getState().setActive(ev.agentId, ev.convId);
      setPage('chat');
    });
  }, [setPage]);
}
