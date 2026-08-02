/**
 * 唤起对话承载窗的渲染入口（独立第二渲染器）——只挂复用的 AsideOverlay，靠主进程 IPC 喂窗外 ⌥ 点。
 *
 * 与主窗的区别只在「输入端」与「承载」：
 * - 输入：不挂 useAsideAltClick（窗内 DOM 事件这窗收不到），改由 window.oruOverlay.onClick 把主进程
 *   截好的整屏 + 坐标推进来，组 AsideClick{ referent:'screen' } 喂现成 dispatch（与 deck 点击同构）。
 * - 承载：透明穿透窗，悬停浮层面板时切可交互、离开切穿透（§7 穿透与输入的矛盾）。
 * 处理端（短评 / 浮层 / 短聊 / 转正 / 计数）整条复用——overlayMachine / AsideOverlay 不为此改。
 *
 * 短聊流式要在本窗出字：复刻主窗 ws 广播→store 的 **chat 子集**（不拖入 taskboard/artifact 等无关分支）。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import type { ServerEvent } from '@shared/protocol';
import type { AsideReferent, ScreenOverlayClick } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { initColorScheme, initTheme } from '@/lib/theme';
import i18n from '@/lib/i18n'; // import 即触发同步 init（含设 i18next 语言 + <html lang>）
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { routeChatEvent } from '@/hooks/useCommentChatRouter';
import { AsideOverlay } from '@/aside/AsideOverlay';
import { ASIDE_OVERLAY_ATTR } from '@/aside/useAsideAltClick';
import { dispatchAsideClick } from '@/aside/dispatch';
import { setAsideOrigin } from '@/aside/origin';
import { clipLabel } from '@/aside/label';
import {
  getAsideOverlayState,
  subscribeAsideOverlay,
  setAsidePromoteNavigator,
} from '@/aside/overlayMachine';
import '../index.css';

// 本进程所有 aside.* 请求标窗外来源（计数分窗外维度，PRD §9）——窗内路径不受影响（默认 'window'）。
setAsideOrigin('screen');

/** 窗外指代：出了 Oru 窗只剩像素 + 前台 app 名（§6）；label = app 名或「屏幕」兜底 */
function screenReferent(app?: string): AsideReferent {
  // label 不进 AI prompt（同 resolve.ts），纯 UI 展示，兜底词随界面语言；app 名是数据不翻
  return { type: 'screen', app, label: clipLabel(app ?? i18n.t('aside:screen')) };
}

/** 主进程推来的窗外 ⌥ 点 → 喂 overlayMachine（自带截图 + 截图坐标，复用 markClickOnScreenshot） */
function onScreenClick(payload: ScreenOverlayClick): void {
  dispatchAsideClick({
    referent: screenReferent(payload.app),
    screenshot: { base64: payload.screenshot, x: payload.shot.x, y: payload.shot.y },
    position: payload.position,
  });
}

/** 复刻主窗 ws 广播→store 的 chat 子集——浮层短聊要的就这些（状态 / 流式 / 历史回放） */
function installOverlayChatBridge(): () => void {
  return wsClient.subscribe((event: ServerEvent) => {
    switch (event.type) {
      case 'agents.state':
        useAgentStore.getState().syncFromServer(event.agents, event.activeId);
        break;
      case 'conv.state':
        useConversationStore.getState().syncForAgent(event.agentId, event.conversations);
        break;
      case 'chat.started':
      case 'chat.delta':
      case 'chat.toolCall':
      case 'chat.toolResult':
      case 'chat.done':
      case 'chat.retrying':
      case 'chat.error':
      case 'chat.proposal':
      case 'chat.askUserChoice':
      case 'chat.taskReport':
      case 'chat.memoryRecord':
      case 'chat.gitHint':
      case 'chat.memoryUndone':
      case 'chat.contextCompressed':
      case 'chat.skillModule':
      case 'chat.subagentChip':
        routeChatEvent(event);
        break;
      case 'conv.history.result':
        useChatStore.getState().loadHistory(event.conversationId, event.messages);
        break;
      default:
        break;
    }
  });
}

/**
 * 穿透切换（§7）：承载窗默认穿透（forward:true 下仍收到 mousemove），光标落在浮层面板上时切可交互、
 * 离开切回穿透——否则透明处也挡住背后 app。用 elementFromPoint 命中 [data-aside-overlay]。
 */
function installPointerForwarding(): () => void {
  let interactive = false;
  const onMove = (e: MouseEvent): void => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const onPanel = !!el?.closest(`[${ASIDE_OVERLAY_ATTR}]`);
    if (onPanel !== interactive) {
      interactive = onPanel;
      window.oruOverlay?.setInteractive(interactive);
    }
  };
  window.addEventListener('mousemove', onMove, true);
  return () => window.removeEventListener('mousemove', onMove, true);
}

/** 浮层归 idle（外点 / ESC / 转正后）→ 请主进程隐藏承载窗（下次重用），并复位穿透 */
function installAutoHide(): () => void {
  return subscribeAsideOverlay(() => {
    if (getAsideOverlayState().phase === 'idle') {
      window.oruOverlay?.setInteractive(false);
      window.oruOverlay?.close();
    }
  });
}

function ScreenOverlayApp(): JSX.Element {
  return <AsideOverlay />;
}

initTheme();
initColorScheme();
installOverlayChatBridge();
installPointerForwarding();
installAutoHide();
// 转正（↗）：浮层关掉后请主进程把 Oru 主窗带前台承接正式对话（主窗导航在主窗那侧，这里只发信号）
setAsidePromoteNavigator(() => window.oruOverlay?.promoted());
// agentStore 灌好才有「这个 Oru」（overlayMachine 取 activeAgentId / 头像）——ws 通了拉一次
void wsClient.ready().then(() => useAgentStore.getState().refresh());
// onClick 在顶层注册（早于首次 IPC 投递，主进程在 did-finish-load 后才发）。
// 故意不接住 cleanup（区别于上面三个 install*）：承载窗渲染进程生命周期 = 整个 app，无卸载点。
window.oruOverlay?.onClick(onScreenClick);

ReactDOM.createRoot(document.getElementById('overlay-root')!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <ScreenOverlayApp />
    </I18nextProvider>
  </React.StrictMode>,
);
