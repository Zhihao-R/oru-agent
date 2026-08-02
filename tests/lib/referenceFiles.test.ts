import { describe, it, expect, beforeEach, vi } from 'vitest';
import { referenceFilesToComposer } from '@/lib/referenceFiles';
import { useChatStore, composerKey } from '@/stores/chatStore';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';

describe('referenceFilesToComposer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAgentStore.setState({ activeAgentId: 'ag1' });
    useConversationStore.setState({ activeByAgent: { ag1: 'cv1' } });
  });

  it('把路径落到 composerKey 对应桶（与文件树口径一致）', () => {
    const addFileRef = vi.spyOn(useChatStore.getState(), 'addFileRef').mockImplementation(() => {});
    referenceFilesToComposer(['docs/a.md', 'b.md']);
    const key = composerKey('ag1', 'cv1');
    expect(addFileRef).toHaveBeenCalledWith(key, { path: 'docs/a.md', name: 'a.md' });
    expect(addFileRef).toHaveBeenCalledWith(key, { path: 'b.md', name: 'b.md' });
  });

  it('无活跃 agent（key 为 null）则不加引用', () => {
    useAgentStore.setState({ activeAgentId: null });
    const addFileRef = vi.spyOn(useChatStore.getState(), 'addFileRef').mockImplementation(() => {});
    referenceFilesToComposer(['docs/a.md']);
    expect(addFileRef).not.toHaveBeenCalled();
  });
});
