import { useChatStore, composerKey } from '@/stores/chatStore';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';

/**
 * 把若干文件作为 file 引用加进当前对话（文件树右键、标签右键、标签拖拽共用）。
 * 用 composerKey 解析桶：新对话（无活跃会话）落草稿桶，与输入框读取口径一致，
 * 否则引用会写进输入框读不到的桶而静默丢失。
 */
export function referenceFilesToComposer(paths: string[]): void {
  const agentId = useAgentStore.getState().activeAgentId;
  const convId = useConversationStore.getState().getActiveConvId(agentId ?? '');
  const key = composerKey(agentId, convId);
  if (!key) return;
  const chat = useChatStore.getState();
  for (const path of paths) {
    chat.addFileRef(key, { path, name: path.split('/').pop() ?? path });
  }
}
