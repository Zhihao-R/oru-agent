/**
 * promote 成功后的导航——overlayMachine 的 setAsidePromoteNavigator 缝的实现，
 * App 挂载时注册（页面切换是 App 的局部 state，经回调注入，本模块不碰 React）。
 *
 * 三步（技术方案 §8）：
 * 1. 切到该对话：rekind 后 conv.state 广播让它进主列表；byId 自 begin 起已注册，
 *    广播未到的瞬间 ChatArea 标题等元信息走 byId 兜底，不闪。
 * 2. 归档分组本地移除：该分组数据按需拉取，没有广播管它。
 * 3. 光标入主输入框：ChatInput 没有对外暴露聚焦 ref（无此先例），按 DOM 查询
 *    [data-chat-area] 区域唯一的 textarea；rAF 等切页/切对话渲染上屏后再聚焦。
 */
import { useConversationStore } from '@/stores/conversationStore';

export function runAsidePromoteNavigation(
  agentId: string,
  conversationId: string,
  showChatPage: () => void,
): void {
  showChatPage();
  const conv = useConversationStore.getState();
  conv.setActive(agentId, conversationId);
  conv.removeArchived(agentId, conversationId);
  // React 18 调度下 setPage 的提交可能晚于首个 rAF（从 deck 页切来时 chat 页尚未挂载）——
  // 查不到就再补一跳；两跳后仍没有则静默放弃（只丢聚焦，不算失败）
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-chat-area] textarea');
    if (input) {
      input.focus();
      return;
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('[data-chat-area] textarea')?.focus();
    });
  });
}
