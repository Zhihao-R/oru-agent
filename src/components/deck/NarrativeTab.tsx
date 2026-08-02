import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { newChatRefId } from '@shared/ids';
import { useEditorStore } from '@/stores/editorStore';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useChatStore, composerKey } from '@/stores/chatStore';
import { MdEditor } from '@/components/editor/MdEditor';

/**
 * 文稿标签：内嵌 MdEditor 编辑这份 deck 的 .narrative.md。
 *
 * 进入时 editorStore.open(projectId, '<deckName>/.narrative.md')——复用编辑器实时落盘全套
 * （停手自动存、失焦立即落、磁盘=屏幕）。历史版本入口在 DeckCenter 标签栏（读同一 editorStore）。
 * 实时落盘下没有「未保存草稿 / 外部改动冲突」，橙条 + ConflictDialog 退场。
 */
type Props = {
  projectId: string;
  narrativePath: string;
};

export function NarrativeTab({ projectId, narrativePath }: Props) {
  const { t } = useTranslation('deck');
  const open = useEditorStore((s) => s.open);
  const fileState = useEditorStore((s) => s.files[narrativePath]);
  const content = fileState?.content ?? '';
  const setContent = useEditorStore((s) => s.setContent);
  const manualSnapshot = useEditorStore((s) => s.manualSnapshot);
  const flush = useEditorStore((s) => s.flush);
  const syncFromDisk = useEditorStore((s) => s.syncFromDisk);
  const close = useEditorStore((s) => s.close);

  // 选段「加入对话」：把选区 + 文稿相对路径作为引用 chip 落进当前 composer。
  // 用 composerKey 解析桶——新对话（草稿态）也能加，引用落草稿桶、发送时随会话搬走。
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const activeConvId = useConversationStore((s) =>
    activeAgentId ? s.activeByAgent[activeAgentId] ?? null : null,
  );
  const composerConvKey = composerKey(activeAgentId, activeConvId);
  const addComposerRef = useChatStore((s) => s.addComposerRef);

  // 进入文稿标签 / 切 deck → 打开对应 .narrative.md（open 内部对相同 path 幂等）。
  // 卸载（关 deck / 进沉浸态）→ close(path)：先 flush 不丢 pending，并销该桶。
  useEffect(() => {
    void open(projectId, narrativePath);
    return () => close(narrativePath);
  }, [open, close, projectId, narrativePath]);

  // 失焦/隐藏立即落盘；切回/可见时刷新（本地无改动则拉磁盘最新，看到 AI/外部的改动）。
  useEffect(() => {
    let composing = false;
    let deferred = false;
    const sync = (): void => {
      if (composing) {
        deferred = true;
        return;
      }
      void syncFromDisk(narrativePath);
    };
    const onFocus = (): void => sync();
    const onBlur = (): void => void flush(narrativePath);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') sync();
      else void flush(narrativePath);
    };
    const onCompositionStart = (): void => {
      composing = true;
    };
    const onCompositionEnd = (): void => {
      composing = false;
      if (deferred) {
        deferred = false;
        void syncFromDisk(narrativePath);
      }
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('compositionstart', onCompositionStart);
    document.addEventListener('compositionend', onCompositionEnd);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('compositionstart', onCompositionStart);
      document.removeEventListener('compositionend', onCompositionEnd);
    };
  }, [narrativePath, syncFromDisk, flush]);

  // 桶建好（open 完成）才渲染编辑器
  const ready = !!fileState && !fileState.loading;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="min-h-0 flex-1 overflow-hidden">
        {ready ? (
          <MdEditor
            value={content}
            onChange={(v) => setContent(narrativePath, v)}
            onSave={() => void manualSnapshot(narrativePath)}
            docIdentity={{ projectId, docPath: narrativePath }}
            onAddToChat={
              composerConvKey
                ? (sel) =>
                    addComposerRef(composerConvKey, {
                      id: newChatRefId(),
                      quote: sel.quote,
                      sourcePath: narrativePath,
                      line: sel.line,
                    })
                : undefined
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-text-tertiary">{t('narrative.loading')}</div>
        )}
      </div>
    </div>
  );
}
