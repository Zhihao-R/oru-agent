/**
 * 主窗口 ⌥点事件接管（随手评点 aside 的主窗口入口）——App 根部挂一次。
 * deck webview 内的对应实现在 electron/preload/deckPreview.ts 的 bindAsideAltClick
 * （webview 的 DOM 事件主窗口收不到，两侧各管一边、同一套吞断模型，技术方案 §3.1）。
 *
 * 吞断模型——window capture 阶段 mousedown + click + dblclick 三监听靠 swallow 标记协作：
 * - mousedown 每次都按 `altKey && 左键 && !豁免区域` 置/清标记。豁免路径不是跳过不碰，
 *   是同样走置/清——否则上次 ⌥点的标记滞留，⌥按住去点浮层按钮会被误吞。
 * - 标记为真：先读选区（浏览器在 mousedown 默认行为里清选区——这是必须在 mousedown 读的
 *   原因）→ 解析 referent → preventDefault → dispatchAsideClick。只 preventDefault 不
 *   stopPropagation：放行传播让全仓 document 级「外点关闭」照常工作（菜单开着时 ⌥点别处，
 *   菜单照常关、浮层照常出）。
 * - click / dblclick 只查标记、从不清标记（事件序列 md₁→click₁→md₂→click₂→dblclick，
 *   click 清标记则 ⌥连点两下的 dblclick 必漏网），命中则 preventDefault + stopPropagation
 *   ——断 React onClick 与原生默认（checkbox 翻态、链接跳转）。`e.detail === 0` 放行：
 *   键盘 Enter/Space 激活与 programmatic click 无 mousedown 前导，不该被滞留标记误吞。
 *   判标记不判 altKey——click 派发前用户可能已松开 ⌥。
 * - 只拦 mousedown 不够：click 是 mouseup 后独立派发的事件，行为吞断必须落在 click 层。
 *
 * 截图与浮层不在此处：dispatch 的 screenshot 留空，浮层 handler 自己调 aside.capture
 * （先截后挂，T11）。
 */
import { useEffect } from 'react';
import type { ChatMessage } from '@shared/types';
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { getEditorSelectionText } from '@/components/editor/editorSelection';
import { dispatchAsideClick } from './dispatch';
import { resolveAsideReferent } from './resolve';

/** 浮层自身的豁免标记——AsideOverlay 根节点挂这个属性（T11 消费） */
export const ASIDE_OVERLAY_ATTR = 'data-aside-overlay';

// 豁免区域：CodeMirror 编辑器内（⌥ 是编辑器自身的多光标/列选手势）与浮层自身
const EXEMPT_SELECTOR = `.cm-editor, [${ASIDE_OVERLAY_ATTR}]`;

/** 按 messageId 在 chatStore 各 conv 桶里找消息——桶数个位数，线性扫足够 */
function findMessageInStore(
  messageId: string,
): { list: readonly ChatMessage[]; index: number } | null {
  for (const list of Object.values(useChatStore.getState().conversations)) {
    const index = list.findIndex((m) => m.id === messageId);
    if (index >= 0) return { list, index };
  }
  return null;
}

/** active 对话的消息列表（blank 档"附近的对话"用） */
function getActiveMessages(): readonly ChatMessage[] {
  const agentId = useAgentStore.getState().activeAgentId;
  const convId = agentId ? useConversationStore.getState().getActiveConvId(agentId) : null;
  return convId ? useChatStore.getState().conversations[convId] ?? [] : [];
}

/**
 * 挂三个 capture 监听，返回成对的清理函数（hook 的 useEffect cleanup 直接 return 它）。
 * 拆出非 React 形态是为了让 jsdom 测试不经 React 渲染直接驱动真实事件序列。
 */
export function installAsideAltClick(): () => void {
  // swallow 标记：生命周期完全由 mousedown 管，click/dblclick 只读不写
  let swallow = false;

  const onMouseDown = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    swallow = e.altKey && e.button === 0 && !target?.closest(EXEMPT_SELECTOR);
    if (!swallow) return;
    // 先读选区——此刻浏览器还没执行"清选区"的默认行为，读到的是"点之前"那份
    const sel = window.getSelection();
    const anchor = sel?.anchorNode ?? null;
    const referent = resolveAsideReferent({
      target,
      selectionText: sel?.toString() ?? '',
      selectionAnchorEl: anchor instanceof Element ? anchor : anchor?.parentElement ?? null,
      getEditorSelection: getEditorSelectionText,
      findMessage: findMessageInStore,
      getActiveMessages,
    });
    e.preventDefault();
    dispatchAsideClick({ referent, position: { x: e.clientX, y: e.clientY } });
  };

  const swallowIfMarked = (e: MouseEvent): void => {
    if (swallow && e.detail !== 0) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('click', swallowIfMarked, true);
  window.addEventListener('dblclick', swallowIfMarked, true);
  return () => {
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('click', swallowIfMarked, true);
    window.removeEventListener('dblclick', swallowIfMarked, true);
  };
}

/** App 根部挂一次；卸载时三个监听一起摘 */
export function useAsideAltClick(): void {
  useEffect(() => installAsideAltClick(), []);
}
